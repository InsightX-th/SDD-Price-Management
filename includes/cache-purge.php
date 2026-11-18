<?php
declare(strict_types=1);
namespace SDD;

/** Durable post-commit invalidation. Price operation results are immutable and independent. */
final class CachePurge {
    public static function settings(): array {
        return array_replace(['capture_enabled'=>false,'dispatch_enabled'=>false,'dry_run'=>true,'inventory_ack'=>false,'per_page'=>12,'devices'=>[],'extra_urls'=>[]], (array)get_option('sdd_cache_settings', []));
    }
    public static function boot(): void {
        add_filter('cron_schedules', static function ($s) { $s['sdd_cache_minute']=['interval'=>60,'display'=>'SoundDD cache recovery']; return $s; });
        add_action('sdd_cache_dispatch',[self::class,'dispatch']);
        add_action('sdd_cache_recover',[self::class,'recover']);
        add_action('sdd_business_retention',[self::class,'prune']);
        add_action('init',[self::class,'schedule'],30);
        add_action('admin_init',static function () {
            if (current_user_can('manage_options') && get_option('sdd_cache_schema_version') !== CacheSchema::VERSION) { CacheSchema::migrate(); }
        });
    }
    public static function schedule(): void {
        if (get_option('sdd_cache_schema_version') !== CacheSchema::VERSION) { return; }
        if (!wp_next_scheduled('sdd_cache_recover')) { wp_schedule_event(time()+60,'sdd_cache_minute','sdd_cache_recover'); }
    }
    public static function deactivate(): void {
        wp_clear_scheduled_hook('sdd_cache_recover'); wp_clear_scheduled_hook('sdd_cache_dispatch');
        if (function_exists('as_unschedule_all_actions')) { as_unschedule_all_actions('sdd_cache_dispatch',[],'sdd-cache'); }
    }
    /** Called before final COMMIT. Failure must roll back both the price and the outbox. */
    public static function capture(int $product, int $parent, string $item, string $operation, string $source): void {
        $settings = self::settings(); if (!$settings['capture_enabled']) { return; }
        if (!CacheSchema::ready()) { throw new \RuntimeException('cache_outbox_unavailable'); }
        $p = wc_get_product($product);
        if (!$p) { throw new \RuntimeException('cache_product_unavailable'); }
        $snapshot = CacheURLs::snapshot($p,$settings); $now=time(); global $wpdb;
        $ok = $wpdb->insert(CacheSchema::table('outbox'),[
            'item_id'=>$item,'operation_id'=>$operation,'product_id'=>$product,'parent_id'=>$parent,'source'=>$source,
            'mode'=>$settings['dry_run']?'dry_run':'live','status'=>'pending','snapshot_json'=>wp_json_encode($snapshot),
            'lease_until'=>$now+5,'created_at'=>$now,'updated_at'=>$now,
        ]);
        if ($ok === false) { throw new \RuntimeException('cache_outbox_insert'); }
    }
    /** Best effort only: exceptions here must never enter the committed writer's failure handler. */
    public static function kick(): void {
        try {
            if (!self::settings()['dispatch_enabled'] || !function_exists('as_schedule_single_action') || !did_action('action_scheduler_init')) { return; }
            if (!CacheSchema::ready()) { return; }
            global $wpdb;
            $j=CacheSchema::table('outbox');$t=CacheSchema::table('targets');
            $due=$wpdb->get_var("SELECT MIN(due_at) FROM (SELECT MIN(lease_until) AS due_at FROM $j WHERE enumerated=0 AND status IN ('pending','enumerating') UNION ALL SELECT MIN(GREATEST(t.next_attempt_at,t.lease_until)) AS due_at FROM $t t JOIN $j j ON j.id=t.outbox_id WHERE j.enumerated=1 AND j.status IN ('processing','retry_wait') AND t.status IN ('pending','retry_wait','processing')) cache_due");
            if ($wpdb->last_error || $due===null) { return; }
            $at=max(time()+5,(int)$due,(int)get_option('sdd_cache_throttle_until',0));
            // A later retry must not delay a newly committed, earlier job. Ignore running actions.
            $pending=function_exists('as_get_scheduled_actions')?as_get_scheduled_actions(['hook'=>'sdd_cache_dispatch','group'=>'sdd-cache','status'=>'pending','date'=>$at,'date_compare'=>'<=','per_page'=>1],'ids'):[];
            if (!$pending) { as_schedule_single_action($at,'sdd_cache_dispatch',[],'sdd-cache'); }
        } catch (\Throwable) { self::log('scheduler_unavailable'); }
    }
    public static function recover(): void {
        // Recovery does not require an administrator browser tab and does not modify prices.
        if (CacheSchema::ready()) {
            global $wpdb;
            $lock = self::dispatchLock();
            if ((string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)', $lock)) === '1') {
                try {
                    $jobs = CacheSchema::table('outbox');
                    $targets = CacheSchema::table('targets');
                    // Repair interrupted acknowledgements and jobs stranded by older releases.
                    $active = "SELECT 1 FROM $targets t WHERE t.outbox_id=j.id AND t.status IN ('pending','processing','retry_wait')";
                    $resume = self::settings()['dispatch_enabled'] ? "OR (j.status='needs_attention' AND j.error_code NOT IN ('configuration_changed','enumeration_failed') AND EXISTS ($active))" : '';
                    $ids = $wpdb->get_col("SELECT j.id FROM $jobs j WHERE j.enumerated=1
                        AND ((j.status IN ('processing','retry_wait') AND NOT EXISTS ($active))
                            $resume)
                        ORDER BY j.id LIMIT 25");
                    foreach ($ids as $id) { self::settle((int)$id); }
                } finally {
                    $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
                }
            }
        }
        self::kick();
    }
    private static function dispatchLock(): string {
        global $wpdb;
        return 'sdd:cf:' . substr(hash('sha256', DB_NAME . ':' . $wpdb->prefix), 0, 40);
    }
    private static function log(string $code): void {
        try {
            if (!function_exists('wc_get_logger') || !SystemLogs::claimLogEmission()) { return; }
            $event=str_starts_with($code,'settings_changed_')?'cache_settings_changed':(str_starts_with($code,'retry_job_')?'cache_retry_requested':($code==='scheduler_unavailable'?'cache_scheduler_failure':'cache_purge_failure'));
            wc_get_logger()->warning($event,['source'=>SystemLogs::SOURCE,'request_id'=>API::requestId()]);
        } catch (\Throwable) { /* Logging is never a price or queue transaction. */ }
    }
    private static function failJob(int $id, string $code, string $token = ''): void {
        global $wpdb; $where=['id'=>$id]; if ($token !== '') { $where['lease_token']=$token; }
        $wpdb->update(CacheSchema::table('outbox'),['status'=>'needs_attention','error_code'=>$code,'lease_token'=>'','lease_until'=>0,'updated_at'=>time()],$where);
        self::log($code);
    }
    private static function compatible(array $job, array $snapshot, array $settings): bool {
        return ($job['mode']==='dry_run') === $settings['dry_run'] && ($snapshot['home']??'') === home_url('/') && ($job['mode']==='dry_run' || ($snapshot['zone']??'')===CloudflareClient::zone());
    }
    private static function enumerate(array $settings): bool {
        global $wpdb; $jobs=CacheSchema::table('outbox'); $targets=CacheSchema::table('targets'); $now=time();
        $job=$wpdb->get_row($wpdb->prepare("SELECT * FROM $jobs WHERE enumerated=0 AND status IN ('pending','enumerating') AND lease_until<=%d ORDER BY id LIMIT 1",$now),ARRAY_A);
        if (!$job) { return false; }
        $id=(int)$job['id']; $token=wp_generate_uuid4();
        if ($wpdb->query($wpdb->prepare("UPDATE $jobs SET lease_token=%s,lease_until=%d,status='enumerating',updated_at=%d WHERE id=%d AND lease_until<=%d AND status IN ('pending','enumerating')",$token,$now+60,$now,$id,$now))!==1) { return true; }
        try {
            $snapshot=json_decode($job['snapshot_json'],true,512,JSON_THROW_ON_ERROR);
            if (!self::compatible($job,$snapshot,$settings)) { self::failJob($id,'configuration_changed',$token); return true; }
            $batch=CacheURLs::batch($snapshot,(int)$job['enumeration_cursor']);
            foreach ($batch['items'] as $file) {
                if (!CacheURLs::validPayload($file,$job['mode']==='dry_run')) { throw new \RuntimeException('unsafe_target'); }
                $json=wp_json_encode($file); $hash=hash('sha256',$json);
                // A crash after inserting some targets repeats safely from the persisted cursor.
                if ($wpdb->query($wpdb->prepare("INSERT INTO $targets (outbox_id,target_hash,payload_json,status,next_attempt_at) VALUES (%d,%s,%s,'pending',%d) ON DUPLICATE KEY UPDATE id=id",$id,$hash,$json,$now))===false) { throw new \RuntimeException('enumeration_database'); }
            }
            if ($wpdb->update($jobs,['enumeration_cursor'=>$batch['cursor'],'enumerated'=>$batch['done']?1:0,'status'=>$batch['done']?'processing':'enumerating','lease_token'=>'','lease_until'=>0,'updated_at'=>$now],['id'=>$id,'lease_token'=>$token])!==1) { throw new \RuntimeException('enumeration_lease'); }
        } catch (\Throwable) { self::failJob($id,'enumeration_failed',$token); }
        return true;
    }
    private static function settle(int $id): void {
        global $wpdb; $t=CacheSchema::table('targets'); $j=CacheSchema::table('outbox');
        $job=$wpdb->get_row($wpdb->prepare("SELECT mode,enumerated FROM $j WHERE id=%d",$id),ARRAY_A);
        if (!$job || !(int)$job['enumerated']) { return; }
        $counts=$wpdb->get_results($wpdb->prepare("SELECT status,COUNT(*) AS n FROM $t WHERE outbox_id=%d GROUP BY status",$id),ARRAY_A);
        if ($wpdb->last_error || !$counts) { self::failJob($id,'status_unavailable'); return; }
        $states=array_column($counts,'n','status');
        // One failed target must not strand later targets from the same product update.
        $pausedForCredentials = !self::settings()['dispatch_enabled'] && get_option('sdd_cache_pause_reason', '') !== '';
        $status = match (true) {
            $pausedForCredentials && isset($states['needs_attention']) => 'needs_attention',
            isset($states['retry_wait']) => 'retry_wait',
            isset($states['pending']) || isset($states['processing']) => 'processing',
            isset($states['needs_attention']) => 'needs_attention',
            default => $job['mode'] === 'dry_run' ? 'simulated' : 'accepted',
        };
        $error=$status==='needs_attention'?(string)$wpdb->get_var($wpdb->prepare("SELECT error_code FROM $t WHERE outbox_id=%d AND status='needs_attention' ORDER BY id LIMIT 1",$id)):'';
        $wpdb->update($j,['status'=>$status,'error_code'=>$error,'updated_at'=>time()],['id'=>$id]);
    }
    public static function dispatch(): void {
        if (!self::settings()['dispatch_enabled'] || !CacheSchema::ready()) { return; }
        // A connection-scoped lock bounds HTTP concurrency. No DB transaction is held during HTTP.
        global $wpdb; $lock = self::dispatchLock();
        if ((string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!=='1') { return; }
        try {
            $settings = self::settings();
            if (!$settings['dispatch_enabled']) { return; }
            $zone = CloudflareClient::zone();
            update_option('sdd_cache_worker_at',time(),false);
            if ((int)get_option('sdd_cache_throttle_until',0)>time()) { return; }
            // Prepare a bounded group so shared URLs can be sent once for several writes.
            for ($batch = 0; $batch < 4 && self::enumerate($settings); $batch++) {}
            $j=CacheSchema::table('outbox');$t=CacheSchema::table('targets');$now=time();$token=wp_generate_uuid4();
            $rows=$wpdb->get_results($wpdb->prepare("SELECT t.*,j.mode,j.snapshot_json FROM $t t JOIN $j j ON j.id=t.outbox_id WHERE j.enumerated=1 AND j.status IN ('processing','retry_wait') AND t.status IN ('pending','retry_wait','processing') AND t.next_attempt_at<=%d AND t.lease_until<=%d ORDER BY t.id LIMIT 100",$now,$now),ARRAY_A);
            if ($wpdb->last_error) { throw new \RuntimeException('queue_read'); }
            $claimed=[];$files=[];$invalidJobs=[];$payloadKind=null;
            foreach ($rows as $row) {
                $jobId = (int)$row['outbox_id'];
                if (isset($invalidJobs[$jobId])) { continue; }
                $snapshot=json_decode($row['snapshot_json'],true);$file=json_decode($row['payload_json'],true);
                if (!is_array($snapshot) || !self::compatible($row, $snapshot, $settings)
                    || ($row['mode'] === 'live' && ($snapshot['zone'] ?? '') !== $zone)) {
                    self::failJob($jobId, 'configuration_changed');
                    $invalidJobs[$jobId] = true;
                    continue;
                }
                if (!is_array($file) || !CacheURLs::validPayload($file, $settings['dry_run'])) {
                    $wpdb->update($t, ['status'=>'needs_attention','error_code'=>'unsafe_target','lease_token'=>'','lease_until'=>0], ['id'=>$row['id']]);
                    self::settle($jobId);
                    continue;
                }
                // Files and prefixes are separate Cloudflare requests. A failed request may only affect its own targets.
                $kind = $file['kind'] ?? 'file';
                $payloadKind ??= $kind;
                if (!$settings['dry_run'] && $kind !== $payloadKind) { continue; }
                if ($wpdb->query($wpdb->prepare("UPDATE $t SET status='processing',lease_token=%s,lease_until=%d,attempts=attempts+1 WHERE id=%d AND lease_until<=%d AND status IN ('pending','retry_wait','processing')",$token,$now+60,(int)$row['id'],$now))===1) {
                    $claimed[]=$row;$files[$row['target_hash']]=$file;
                }
            }
            if (!$claimed) { return; }
            if (!$settings['dry_run'] && !self::liveVerified()) { $result=['ok'=>false,'permanent'=>true,'code'=>'live_not_verified','retry_after'=>0]; }
            else { $result=$settings['dry_run']?['ok'=>true,'permanent'=>false,'code'=>'','retry_after'=>0]:CloudflareClient::purge(array_values($files), $zone); }
            $now=time(); // Retry-After starts when the response arrives, not before enumeration/HTTP.
            if (!$result['ok']) { self::log($result['code']); }
            $delay=max((int)$result['retry_after'],5);
            if ($result['code']==='cloudflare_429') { update_option('sdd_cache_throttle_until',$now+$delay,false); }
            // Permanent authorization errors pause dispatch globally until administrator intervention.
            $authRejected = in_array($result['code'], ['cloudflare_401','cloudflare_403','cloudflare_404'], true);
            if ($authRejected) {
                // Another request may have saved new credentials while this HTTP call was in flight.
                wp_cache_delete_multiple(['sdd_cf_connection', 'sdd_cf_verification_failure', 'notoptions'], 'options');
            }
            $failedActiveCredential = $authRejected && (!CloudflareClient::hasSavedCredentials() || !CloudflareClient::verified());
            if (!$result['ok'] && ($failedActiveCredential || in_array($result['code'], ['live_not_verified','configuration'], true))) {
                update_option('sdd_cache_pause_reason', $result['code'], false);
                $paused = self::settings();
                $paused['dispatch_enabled'] = false;
                update_option('sdd_cache_settings', $paused, false);
            }
            $jobs=[];
            foreach ($claimed as $row) {
                $attempt=(int)$row['attempts']+1;
                $status=$result['ok']?($row['mode']==='dry_run'?'simulated':'accepted'):($result['permanent']||$attempt>=8?'needs_attention':'retry_wait');
                $wait=max($delay,min(3600,15*(2**min($attempt,8)))+wp_rand(0,10));
                $wpdb->update($t,['status'=>$status,'lease_token'=>'','lease_until'=>0,'next_attempt_at'=>$now+$wait,'accepted_at'=>$result['ok']?$now:null,'error_code'=>$result['code']],['id'=>$row['id'],'lease_token'=>$token]);
                $jobs[(int)$row['outbox_id']]=true;
            }
            foreach (array_keys($jobs) as $id) { self::settle($id); }
        } catch (\Throwable) { self::log('worker_failure'); }
        finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));self::kick(); }
    }
    public static function zoneChangeBlocked(string $zone): bool {
        if ($zone === CloudflareClient::zone() || !CacheSchema::ready()) { return false; }
        global $wpdb;
        $jobs = CacheSchema::table('outbox');
        $pending = $wpdb->get_var("SELECT 1 FROM $jobs WHERE mode='live' AND status NOT IN ('accepted','simulated','closed') LIMIT 1");
        return $wpdb->last_error !== '' || $pending !== null;
    }
    public static function liveVerified(): bool {
        if (CloudflareClient::hasSavedCredentials()) { return CloudflareClient::verified(); }
        $reason = (string)get_option('sdd_cache_pause_reason', '');
        return defined('SDD_CF_LIVE_VERIFIED') && SDD_CF_LIVE_VERIFIED === true
            && !in_array($reason, ['cloudflare_401','cloudflare_403','cloudflare_404'], true);
    }
    public static function configResponse(): array {
        return ['discovered_pages'=>CacheDiscovery::urls(self::settings()['dry_run']),'settings'=>self::settings(),'connection'=>CloudflareClient::connection(),'schema_ready'=>CacheSchema::ready(),'credentials_ready'=>CloudflareClient::configured(),'live_verified'=>self::liveVerified(),'scheduler_ready'=>self::schedulerReady(),'coverage'=>'sdd_only','last_settings_change'=>get_option('sdd_cache_settings_audit',null),'note'=>'ครอบคลุมการแก้ผ่าน SoundDD เท่านั้น การแก้จาก WooCommerce/import/ระบบอื่นต้องตรวจระบบล้างแคชเดิม'];
    }
    public static function saveSettings(mixed $in): array|\WP_Error {
        if (!current_user_can('manage_options')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if (is_array($in)) { $in=array_replace(['inventory_ack'=>true,'per_page'=>12,'devices'=>[]],$in); }
        $keys=['capture_enabled','dispatch_enabled','dry_run','inventory_ack','per_page','devices','extra_urls'];
        if (!is_array($in)||array_diff(array_keys($in),$keys)||array_diff($keys,array_keys($in))) { return API::error('invalid_input','ข้อมูลตั้งค่าแคชไม่ครบ',400); }
        foreach (['capture_enabled','dispatch_enabled','dry_run','inventory_ack'] as $key) { if (!is_bool($in[$key])) { return API::error('invalid_input','รูปแบบการตั้งค่าไม่ถูกต้อง',400); } }
        if (!is_int($in['per_page'])||$in['per_page']<1||$in['per_page']>100||!is_array($in['devices'])||!array_is_list($in['devices'])||count($in['devices'])>3||count(array_filter($in['devices'],'is_string'))!==count($in['devices'])||array_diff($in['devices'],['desktop','mobile','tablet'])||!is_array($in['extra_urls'])||!array_is_list($in['extra_urls'])||count($in['extra_urls'])>100) { return API::error('invalid_input','ตรวจจำนวนสินค้าต่อหน้าและประเภทอุปกรณ์',400); }
        foreach ($in['extra_urls'] as $url) { if (!is_string($url)||!CacheURLs::allowed($url,$in['dry_run'])) { return API::error('invalid_url','URL ต้องเป็นหน้าสาธารณะบนโดเมนเว็บไซต์นี้',400); } }
        $in['devices']=array_values(array_unique($in['devices']));sort($in['devices']);$in['extra_urls']=array_values(array_unique($in['extra_urls']));
        if (($in['capture_enabled']||$in['dispatch_enabled']) && (!CacheSchema::ready()||!$in['inventory_ack'])) { return API::error('cache_not_ready','ตรวจฐานข้อมูลและยืนยันรายการหน้าเว็บก่อนเปิดใช้',503); }
        if ($in['dispatch_enabled'] && !self::schedulerReady()) { return API::error('scheduler_unavailable','Action Scheduler ยังไม่พร้อม งานจะถูกเก็บไว้',503); }
        $previous = self::settings();
        $enteringLive = $in['capture_enabled'] && ($previous['dry_run'] || !$previous['capture_enabled']);
        if (!$in['dry_run'] && ($in['dispatch_enabled'] || $enteringLive) && (!CloudflareClient::configured() || !self::liveVerified())) {
            return API::error('live_not_ready','ตรวจการเชื่อมต่อ Cloudflare ก่อนเริ่มส่งคำขอจริง',503);
        }
        if ($in['dry_run'] !== $previous['dry_run'] && CacheSchema::ready()) {
            global $wpdb;
            $jobs = CacheSchema::table('outbox');
            $oldMode = $in['dry_run'] ? 'live' : 'dry_run';
            $pending = $wpdb->get_var($wpdb->prepare("SELECT 1 FROM $jobs WHERE mode=%s AND status NOT IN ('accepted','simulated','closed') LIMIT 1", $oldMode));
            if ($wpdb->last_error || $pending !== null) {
                return API::error('mode_change_pending','รอให้งานเดิมจบก่อนเปลี่ยนโหมด หากพักการส่งอยู่ ให้เปิดการส่งและจัดการงานที่ต้องตรวจสอบก่อน',409);
            }
        }
        update_option('sdd_cache_settings',$in,false);
        if ($in['dispatch_enabled']) { delete_option('sdd_cache_pause_reason'); }
        update_option('sdd_cache_settings_audit',['actor_id'=>get_current_user_id(),'at'=>gmdate('c')],false);self::schedule();self::kick();
        self::log('settings_changed_by_' . get_current_user_id());return self::configResponse();
    }
    /** Batch projection for visible products only; do not leak errors, credentials, URLs or actors. */
    public static function statuses(array $ids): array {
        $ids=array_values(array_unique(array_filter(array_map('intval',$ids))));if (!$ids) { return []; }
        $fallback=self::settings()['capture_enabled']?'unavailable':'disabled';$result=[];
        foreach ($ids as $id) { $result[(string)$id]=['state'=>$fallback]; }
        if (!CacheSchema::ready()) { return $result; }
        global $wpdb;$j=CacheSchema::table('outbox');$marks=implode(',',array_fill(0,count($ids),'%d'));
        // Two bounded aggregates avoid loading a full product's historical job list on each heartbeat.
        $sql="SELECT product_id,MAX(id) AS latest, SUM(status NOT IN ('accepted','simulated','closed')) AS pending,
            MAX(CASE WHEN status='needs_attention' THEN id END) AS error_job,
            MAX(CASE WHEN status IN ('pending','enumerating','processing','retry_wait') THEN id END) AS active_job,
            MAX(CASE WHEN status='retry_wait' THEN id END) AS retry_job,
            MAX(CASE WHEN status='processing' THEN id END) AS processing_job
            FROM (SELECT id,product_id,status FROM $j WHERE product_id IN ($marks)
            UNION ALL SELECT id,parent_id AS product_id,status FROM $j WHERE parent_id IN ($marks) AND parent_id<>product_id) visible_jobs GROUP BY product_id";
        $groups=$wpdb->get_results($wpdb->prepare($sql,...array_merge($ids,$ids)),ARRAY_A);
        if ($wpdb->last_error) { return $result; }
        foreach ($ids as $id) { $result[(string)$id]=['state'=>self::settings()['capture_enabled']?'idle':'disabled']; }
        if (!$groups) { return $result; }
        $dispatchEnabled = self::settings()['dispatch_enabled'];
        $statusId = static fn(array $g) => (int)($g['error_job'] ?? ($dispatchEnabled ? ($g['processing_job'] ?? $g['retry_job']) : null) ?? $g['active_job'] ?? $g['latest']);
        $jobIds=array_values(array_unique(array_map($statusId,$groups)));$m=implode(',',array_fill(0,count($jobIds),'%d'));
        $rows=$wpdb->get_results($wpdb->prepare("SELECT id,status,updated_at,mode FROM $j WHERE id IN ($m)",...$jobIds),OBJECT_K);
        if ($wpdb->last_error) { foreach ($ids as $id) { $result[(string)$id]=['state'=>'unavailable']; }return $result; }
        foreach ($groups as $g) {
            $jobId = $statusId($g);
            $row=$rows[$jobId]??null;
            if (!$row) { continue; }
            $state = match (true) {
                $row->status === 'needs_attention' => 'needs_attention',
                (int)$g['pending'] === 0 => $row->status,
                !$dispatchEnabled => 'paused',
                $row->status === 'processing' => 'processing',
                $row->status === 'retry_wait' => 'retry_wait',
                default => 'pending',
            };
            $result[(string)$g['product_id']]=['state'=>$state,'job_id'=>(string)$jobId,'pending'=>(int)$g['pending'],'updated_at'=>gmdate('c',(int)$row->updated_at),'mode'=>$row->mode];
        }
        return $result;
    }
    public static function summary(): array {
        $settings = self::settings();
        $dispatch = $settings['dispatch_enabled'];
        $worker = (int)get_option('sdd_cache_worker_at', 0);
        $reason = $dispatch ? '' : (string)get_option('sdd_cache_pause_reason', '');
        if (!$settings['dry_run'] && !$reason && !self::liveVerified()) { $reason = 'live_not_verified'; }
        $base = [
            'state'=>'disabled', 'operational_state'=>'disabled', 'pending'=>0, 'attention'=>0,
            'oldest_at'=>null, 'next_retry_at'=>null, 'last_accepted_at'=>null,
            'dispatch_enabled'=>$dispatch, 'dry_run'=>$settings['dry_run'],
            'worker_at'=>$worker, 'worker_stale'=>false, 'pause_reason'=>$reason ?: null,
        ];
        $unavailable = ['state'=>'unavailable', 'operational_state'=>'unavailable'];
        if (!CacheSchema::ready()) {
            return $settings['capture_enabled'] || $dispatch ? array_replace($base, $unavailable) : $base;
        }
        global $wpdb;
        $jobs = CacheSchema::table('outbox');
        $targets = CacheSchema::table('targets');
        $queue = $wpdb->get_row("SELECT
            SUM(status NOT IN ('accepted','simulated','closed')) AS pending,
            SUM(status='needs_attention') AS attention,
            MIN(CASE WHEN status NOT IN ('accepted','simulated','closed') THEN created_at END) AS oldest,
            MIN(CASE WHEN status IN ('pending','enumerating','processing','retry_wait') THEN created_at END) AS oldest_active,
            MAX(CASE WHEN status='accepted' THEN updated_at END) AS last_accepted
            FROM $jobs", ARRAY_A);
        if ($wpdb->last_error || !$queue) { return array_replace($base, $unavailable); }
        $next = $wpdb->get_row("SELECT
            MIN(CASE WHEN t.status='retry_wait' THEN GREATEST(t.next_attempt_at,t.lease_until) END) AS retry_at,
            MIN(GREATEST(t.next_attempt_at,t.lease_until)) AS due_at
            FROM $targets t JOIN $jobs j ON j.id=t.outbox_id
            WHERE j.status IN ('processing','retry_wait') AND t.status IN ('pending','processing','retry_wait')", ARRAY_A);
        if ($wpdb->last_error || !$next) { return array_replace($base, $unavailable); }
        $incomplete = $wpdb->get_var("SELECT MIN(lease_until) FROM $jobs WHERE status IN ('pending','enumerating')");
        if ($wpdb->last_error) { return array_replace($base, $unavailable); }
        $due = array_filter([$incomplete, $next['due_at']], static fn($value) => $value !== null);
        $throttle = (int)get_option('sdd_cache_throttle_until', 0);
        $staleBefore = time() - 180;
        $stale = $dispatch && $due && max(min(array_map('intval', $due)), $throttle, $worker, (int)$queue['oldest_active']) < $staleBefore;
        $available = $settings['capture_enabled'] || $dispatch || (int)$queue['pending'] > 0;
        $operationalState = match (true) {
            !$available => 'disabled',
            $reason !== '' => 'paused_error',
            !$dispatch => 'paused',
            !self::schedulerReady() => 'unavailable',
            $stale => 'stalled',
            $settings['dry_run'] => 'dry_run',
            default => 'running',
        };
        return array_replace($base, [
            'state'=>$available ? 'available' : 'disabled',
            'operational_state'=>$operationalState,
            'pending'=>(int)$queue['pending'],
            'attention'=>(int)$queue['attention'],
            'oldest_at'=>self::timestamp($queue['oldest']),
            'next_retry_at'=>$dispatch && $reason === '' && $next['retry_at'] !== null ? self::timestamp(max((int)$next['retry_at'], $throttle)) : null,
            'last_accepted_at'=>self::timestamp($queue['last_accepted']),
            'worker_stale'=>$stale,
        ]);
    }
    private static function timestamp(mixed $value): ?string {
        return (int)$value > 0 ? gmdate('c', (int)$value) : null;
    }
    private static function schedulerReady(): bool {
        return function_exists('as_schedule_single_action') && did_action('action_scheduler_init') > 0;
    }
    /** Called only after Bulk::owned() has authorized the immutable batch preview. Units are jobs. */
    public static function operationSummary(array $operations): array {
        if (!CacheSchema::ready()) { return ['state'=>'unavailable','jobs'=>null,'pending'=>null]; }
        $operations=array_values(array_unique($operations));
        if (!$operations) { return ['state'=>'available','jobs'=>0,'pending'=>0]; }
        global $wpdb;$marks=implode(',',array_fill(0,count($operations),'%s'));
        $r=$wpdb->get_row($wpdb->prepare("SELECT COUNT(*) AS jobs,SUM(status NOT IN ('accepted','simulated','closed')) AS pending FROM ".CacheSchema::table('outbox')." WHERE operation_id IN ($marks)",...$operations),ARRAY_A);
        return $wpdb->last_error||!$r?['state'=>'unavailable','jobs'=>null,'pending'=>null]:['state'=>'available','jobs'=>(int)$r['jobs'],'pending'=>(int)$r['pending']];
    }
    public static function health(int $page = 1, string $filter = 'all'): array {
        $filters = [
            'all' => '1=1',
            'attention' => "j.status='needs_attention'",
            'pending' => "j.status IN ('pending','enumerating','processing','retry_wait')",
        ];
        $filter = isset($filters[$filter]) ? $filter : 'all';
        $where = $filters[$filter];
        $perPage = 25;
        $response = self::configResponse() + [
            'queue'=>self::summary(), 'jobs'=>[], 'jobs_error'=>false,
            'jobs_pagination'=>['page'=>1, 'per_page'=>$perPage, 'total'=>0, 'total_pages'=>0, 'filter'=>$filter],
        ];
        if (!$response['schema_ready']) { return $response; }
        global $wpdb;
        $jobs = CacheSchema::table('outbox');
        $targets = CacheSchema::table('targets');
        $total = (int)$wpdb->get_var("SELECT COUNT(*) FROM $jobs j WHERE $where");
        if ($wpdb->last_error) { $response['jobs_error'] = true; return $response; }
        $totalPages = (int)ceil($total / $perPage);
        $page = max(1, min($page, $totalPages));
        $response['jobs_pagination'] = ['page'=>$page, 'per_page'=>$perPage, 'total'=>$total, 'total_pages'=>$totalPages, 'filter'=>$filter];
        if (!$total) { return $response; }

        $rows = $wpdb->get_results($wpdb->prepare("SELECT j.id,j.product_id,j.parent_id,j.operation_id,j.source,j.mode,j.status,
            j.enumeration_cursor,j.enumerated,j.error_code,j.retry_count,j.last_retry_actor,j.created_at,j.updated_at,j.snapshot_json,
            (SELECT MIN(GREATEST(t.next_attempt_at,t.lease_until)) FROM $targets t WHERE t.outbox_id=j.id AND t.status='retry_wait') AS retry_at,
            (SELECT MAX(t.accepted_at) FROM $targets t WHERE t.outbox_id=j.id AND t.status='accepted') AS accepted_at
            FROM $jobs j WHERE $where ORDER BY (j.status='needs_attention') DESC,j.id DESC LIMIT %d OFFSET %d",
            $perPage, ($page - 1) * $perPage), ARRAY_A);
        if ($wpdb->last_error) { $response['jobs_error'] = true; return $response; }
        $settings = $response['settings'];
        $throttle = (int)get_option('sdd_cache_throttle_until', 0);
        foreach ((array)$rows as $row) {
            $product = wc_get_product((int)$row['product_id']);
            $url = get_permalink((int)$row['parent_id'] ?: (int)$row['product_id']);
            $snapshot = json_decode($row['snapshot_json'], true);
            $blocked = false;
            if (in_array($row['status'], ['needs_attention','retry_wait'], true)) {
                if (!is_array($snapshot) || !self::compatible($row, $snapshot, $settings)) { $blocked = 'configuration_changed'; }
                elseif ((int)$row['retry_count'] >= 5) { $blocked = 'replay_limit'; }
            }
            $row['product_name'] = $product ? $product->get_name() : '';
            $row['sku'] = $product ? $product->get_sku() : '';
            $row['current_price'] = $product ? $product->get_price('edit') : null;
            $row['permalink'] = is_string($url) && CacheURLs::allowed($url, $settings['dry_run']) ? $url : null;
            $row['next_retry_at'] = $settings['dispatch_enabled'] && $row['retry_at'] !== null
                ? self::timestamp(max((int)$row['retry_at'], $throttle)) : null;
            $row['last_accepted_at'] = self::timestamp($row['accepted_at']);
            $row['retry_blocked'] = $blocked;
            $row['can_close'] = self::canClose($row['status'], $settings['dispatch_enabled']);
            unset($row['retry_at'], $row['accepted_at'], $row['snapshot_json']);
            $response['jobs'][] = $row;
        }
        return $response;
    }
    public static function retry(int $id): array|\WP_Error {
        if (!current_user_can('manage_options')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if (!CacheSchema::ready()) { return API::error('cache_unavailable','คิวไม่พร้อม',503); }
        global $wpdb;$j=CacheSchema::table('outbox');$t=CacheSchema::table('targets');
        $row=$wpdb->get_row($wpdb->prepare("SELECT * FROM $j WHERE id=%d",$id),ARRAY_A);
        if (!$row) { return API::error('not_found','ไม่พบงาน',404); }
        if (!in_array($row['status'],['needs_attention','retry_wait'],true)) { return API::error('not_retryable','งานนี้ยังทำงานอยู่หรือจบแล้ว',409); }
        $snapshot=json_decode($row['snapshot_json'],true);
        if (!is_array($snapshot)||!self::compatible($row,$snapshot,self::settings())) { return API::error('configuration_changed','โหมดหรือเว็บไซต์เปลี่ยนแล้ว ต้องตรวจแผนงานเดิม ห้าม replay ข้าม dry run/live',409); }
        if ((int)$row['retry_count']>=5) { return API::error('replay_limit','ลองใหม่ครบจำนวนแล้ว ให้ตรวจสาเหตุก่อน',409); }
        // Serialize against dispatch, including the non-transactional HTTP window.
        $lock = self::dispatchLock();
        if ((string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)',$lock))!=='1') { return API::error('cache_busy','ระบบกำลังทำงาน กรุณาลองอีกครั้ง',409); }
        try {
            if ($wpdb->query('START TRANSACTION')===false) { throw new \RuntimeException(); }
            if ($wpdb->query($wpdb->prepare("UPDATE $t SET status='pending',attempts=0,next_attempt_at=%d,lease_token='',lease_until=0,error_code='' WHERE outbox_id=%d AND status IN ('needs_attention','retry_wait')",time(),$id))===false) { throw new \RuntimeException(); }
            if ($wpdb->query($wpdb->prepare("UPDATE $j SET status=IF(enumerated=1,'processing','pending'),lease_token='',lease_until=0,error_code='',retry_count=retry_count+1,last_retry_actor=%d,updated_at=%d WHERE id=%d AND retry_count=%d AND status IN ('needs_attention','retry_wait')",get_current_user_id(),time(),$id,(int)$row['retry_count']))!==1) { throw new \RuntimeException(); }
            if ($wpdb->query('COMMIT')===false) { throw new \RuntimeException(); }
        } catch (\Throwable) { $wpdb->query('ROLLBACK');return API::error('retry_failed','ยังยืนยันการลองใหม่ไม่ได้ กรุณารีเฟรชสถานะ',503); }
        finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock)); }
        self::log('retry_job_' . $id . '_by_' . get_current_user_id());
        self::kick();
        return ['ok'=>true,'job_id'=>(string)$id,'queued'=>true,'dispatch_enabled'=>self::settings()['dispatch_enabled']];
    }
    public static function close(int $id): array|\WP_Error {
        if (!current_user_can('manage_options')) { return API::error('forbidden', 'สิทธิ์ไม่เพียงพอ', 403); }
        if (!CacheSchema::ready()) { return API::error('cache_unavailable', 'คิวไม่พร้อม', 503); }
        global $wpdb;
        $jobs = CacheSchema::table('outbox');
        $targets = CacheSchema::table('targets');
        $lock = self::dispatchLock();
        if ((string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,0)', $lock)) !== '1') {
            return API::error('cache_busy', 'ระบบกำลังทำงาน กรุณาลองอีกครั้ง', 409);
        }
        try {
            $status = $wpdb->get_var($wpdb->prepare("SELECT status FROM $jobs WHERE id=%d", $id));
            if ($wpdb->last_error) { throw new \RuntimeException(); }
            if ($status === null) { return API::error('not_found', 'ไม่พบงาน', 404); }
            if ($status === 'closed') { return ['ok'=>true, 'job_id'=>(string)$id]; }
            if (!self::canClose($status, self::settings()['dispatch_enabled'])) {
                return API::error('not_closeable', 'ปิดได้เฉพาะงานที่ต้องตรวจสอบ หรืองานที่ยังค้างระหว่างพักการส่ง', 409);
            }
            if ($wpdb->query('START TRANSACTION') === false) { throw new \RuntimeException(); }
            if ($wpdb->query($wpdb->prepare("UPDATE $targets SET status='closed', lease_token='', lease_until=0
                WHERE outbox_id=%d AND status IN ('pending','processing','retry_wait','needs_attention')", $id)) === false) {
                throw new \RuntimeException();
            }
            if ($wpdb->update($jobs, [
                'status'=>'closed', 'error_code'=>'closed_by_admin', 'last_retry_actor'=>get_current_user_id(),
                'updated_at'=>time(), 'lease_token'=>'', 'lease_until'=>0,
            ], ['id'=>$id, 'status'=>$status]) !== 1 || $wpdb->query('COMMIT') === false) {
                throw new \RuntimeException();
            }
        } catch (\Throwable) {
            $wpdb->query('ROLLBACK');
            return API::error('close_failed', 'ยังยืนยันการปิดงานไม่ได้ กรุณารีเฟรชสถานะ', 503);
        } finally {
            $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock));
        }
        return ['ok'=>true, 'job_id'=>(string)$id];
    }
    private static function canClose(string $status, bool $dispatchEnabled): bool {
        return $status === 'needs_attention'
            || (!$dispatchEnabled && in_array($status, ['pending','enumerating','processing','retry_wait'], true));
    }
    public static function protectsOperation(string $alias = 'o'): string {
        if (!CacheSchema::ready()) { return self::settings()['capture_enabled']?' AND 1=0':''; }
        return " AND NOT EXISTS (SELECT 1 FROM " . CacheSchema::table('outbox') . " cq WHERE cq.status NOT IN ('accepted','simulated','closed') AND (cq.operation_id=$alias.operation_id OR JSON_SEARCH(CASE WHEN JSON_VALID($alias.preview_json)=1 THEN $alias.preview_json ELSE '{}' END,'one',cq.operation_id,NULL,'$.items[*].child_operation') IS NOT NULL))";
    }
    public static function prune(): void {
        if (!CacheSchema::ready()) { return; }global $wpdb;$j=CacheSchema::table('outbox');$t=CacheSchema::table('targets');
        $ids=$wpdb->get_col($wpdb->prepare("SELECT id FROM $j WHERE status IN ('accepted','simulated','closed') AND updated_at<%d ORDER BY id LIMIT 25",time()-30*DAY_IN_SECONDS));
        if (!$ids) { return; }$ids=array_map('intval',$ids);$marks=implode(',',array_fill(0,count($ids),'%d'));
        if ($wpdb->query('START TRANSACTION')===false) { return; }
        if ($wpdb->query($wpdb->prepare("DELETE FROM $t WHERE outbox_id IN ($marks)",...$ids))===false||$wpdb->query($wpdb->prepare("DELETE FROM $j WHERE id IN ($marks) AND status IN ('accepted','simulated','closed')",...$ids))===false) { $wpdb->query('ROLLBACK');return; }
        $wpdb->query('COMMIT');
    }
}
