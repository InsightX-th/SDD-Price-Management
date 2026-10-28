<?php
declare(strict_types=1);
namespace SDD;
/** Temporary promotions preserve a separate, immutable native-sale snapshot. */
final class TemporarySales {
    private static int $ownProduct = 0;
    private static bool $booted = false;
    public static function boot(): void {
        if (self::$booted) { return; } self::$booted = true;
        add_filter('cron_schedules', static function ($s) { $s['sdd_minute'] = ['interval' => 60, 'display' => 'SoundDD every minute']; return $s; });
        add_action('sdd_temporary_sale_tick', [self::class, 'tick'], 10, 2);
        add_action('sdd_temporary_sale_scan', [self::class, 'scan']);
        foreach (['added_post_meta','updated_post_meta','deleted_post_meta'] as $hook) { add_action($hook, [self::class, 'changed'], 10, 4); }
        add_action('woocommerce_after_product_object_save', [self::class, 'nativeSaved'], 99);
        add_action('admin_init', static function () {
            if (current_user_can('sdd_manage_settings') && get_option('sdd_schema_version') !== Schema::VERSION) { Schema::activate(); }
            if (Schema::ready() && self::hasLive()) { self::scheduleScan(); }
        });
    }
    private static function table(): string { return Schema::table('temporary_sales'); }
    private static function hasLive(): bool { global $wpdb; return (bool)$wpdb->get_var('SELECT id FROM ' . self::table() . " WHERE status IN ('pending','active') LIMIT 1"); }
    private static function scheduleScan(): void {
        if (!wp_next_scheduled('sdd_temporary_sale_scan')) { wp_schedule_event(time()+60, 'sdd_minute', 'sdd_temporary_sale_scan'); }
    }
    public static function snapshot(\WC_Product $p): array { return array_intersect_key(Policy::values($p), array_flip(['regular_price','sale_price','sale_dates'])); }
    public static function hasOriginalSale(array $base): bool { return isset($base['sale_price']) && $base['sale_price'] !== '' && $base['sale_price'] !== '0'; }
    public static function reference(array $base, int $at): array {
        return ['price'=>$base['regular_price'],'reason'=>'ใช้ราคาปกติเป็นราคาอ้างอิง'];
    }
    private static function native(): bool {
        return doing_action('wc_product_start_scheduled_sale') || doing_action('wc_product_end_scheduled_sale') || doing_action('woocommerce_scheduled_sales');
    }
    public static function changed($metaId, $id, $key, $value): void {
        if ((int)$id === self::$ownProduct || !in_array($key, ['_regular_price','_sale_price','_sale_price_dates_from','_sale_price_dates_to','_price'], true) || get_option('sdd_schema_version') !== Schema::VERSION) { return; }
        global $wpdb;
        // Native schedule changes while pending are incorporated only after its CRUD save.
        $states = self::native() ? "('active')" : "('pending','active')";
        $rows = $wpdb->get_results($wpdb->prepare('SELECT id,status FROM ' . self::table() . " WHERE product_id=%d AND status IN $states", $id), ARRAY_A);
        // wpdb->update validates each column's charset. A raw Thai UPDATE on a mixed
        // ASCII UUID / utf8 table is rejected by wpdb's whole-query charset check.
        foreach ($rows as $row) {
            $saved = $wpdb->update(self::table(), ['status'=>'needs_review','message'=>'พบการแก้ราคา/วันโปรภายนอก หยุดเริ่มและคืนอัตโนมัติ กรุณาตรวจราคา','updated_at'=>gmdate('Y-m-d H:i:s')], ['id'=>$row['id'],'status'=>$row['status']]);
            if ($saved === false) { $settings = Policy::settings(); $settings['write_stop'] = true; update_option('sdd_settings', $settings, false); API::log('writer_failure'); }
        }
    }
    public static function nativeSaved($p): void {
        if (!self::native() || self::$ownProduct === $p->get_id() || get_option('sdd_schema_version') !== Schema::VERSION) { return; }
        global $wpdb;
        $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . self::table() . " WHERE product_id=%d AND status='pending'", $p->get_id()), ARRAY_A);
        foreach ($rows as $row) {
            $expected = json_decode($row['expected_json'], true); $actual = self::snapshot($p);
            $legacyEnd = array_intersect_key($expected,array_flip(['regular_price','sale_price','sale_dates'])); $legacyEnd['sale_price'] = ''; $legacyEnd['sale_dates'] = '|';
            $allowedEnd = (doing_action('wc_product_end_scheduled_sale') || doing_action('woocommerce_scheduled_sales')) && $actual === $legacyEnd;
            if ($actual !== array_intersect_key($expected,array_flip(['regular_price','sale_price','sale_dates'])) && !$allowedEnd) {
                self::update($row['id'], ['status'=>'needs_review','message'=>'พบการเปลี่ยนราคาแทรกในงาน native schedule ต้องตรวจสอบ']);
            } else { self::update($row['id'], ['expected_json'=>wp_json_encode(array_merge($actual,array_intersect_key($expected,array_flip(['_revive_expired']))))]); }
        }
    }
    private static function update(string $id, array $data): void {
        global $wpdb; $data['updated_at'] = gmdate('Y-m-d H:i:s');
        if ($wpdb->update(self::table(), $data, ['id' => $id]) === false) { throw new \RuntimeException('Promotion state write failed.'); }
    }
    private static function updateState(string $id, string $before, array $data): void {
        global $wpdb; $data['updated_at'] = gmdate('Y-m-d H:i:s');
        if ($wpdb->update(self::table(), $data, ['id'=>$id,'status'=>$before]) !== 1) { throw new \RuntimeException('Promotion state changed during write.'); }
    }
    private static function row(string $id): ?array { global $wpdb; return $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . self::table() . ' WHERE id=%s', $id), ARRAY_A) ?: null; }
    private static function publicRow(array $r): array {
        $original = json_decode($r['original_json'], true);
        return ['id' => $r['id'], 'product_id' => (string)$r['product_id'], 'status' => $r['status'], 'price' => $r['sale_price'], 'starts_at' => (string)$r['starts_at'], 'ends_at' => (string)$r['ends_at'], 'original' => $original, 'message' => $r['message'], 'revive_expired' => (bool)(json_decode($r['expected_json'], true)['_revive_expired'] ?? false), 'reference_price' => self::reference($original, (int)$r['starts_at'])['price']];
    }
    public static function listing(int $id): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !Policy::accessible($id, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์จัดการโปรสินค้านี้', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'Schema ไม่พร้อม', 503); }
        global $wpdb;
        $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . self::table() . ' WHERE product_id=%d ORDER BY created_at DESC,id DESC LIMIT 5', $id), ARRAY_A);
        $p = Writer::fresh($id);
        return ['items' => array_map([self::class,'publicRow'], $rows), 'baseline' => $p ? self::snapshot($p) : null, 'timezone' => wp_timezone_string(), 'server_time' => (string)time()];
    }
    private static function uuid(mixed $s): bool { return is_string($s) && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $s) === 1; }
    private static function parseTime(mixed $s): ?int {
        if (!is_string($s) || !preg_match('/^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/D', $s)) { return null; }
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $s, wp_timezone());
        return $d && $d->format('Y-m-d\TH:i') === $s ? $d->getTimestamp() : null;
    }
    private static function lock(string $key): ?string {
        global $wpdb; $lock = 'sdd:' . substr(hash('sha256', DB_NAME . ':' . $wpdb->prefix . ':' . $key), 0, 58);
        return (string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,3)', $lock)) === '1' ? $lock : null;
    }
    private static function unlock(array $locks): void { global $wpdb; foreach (array_reverse($locks) as $lock) { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock)); } }
    public static function create(int $id, mixed $in): array|\WP_Error {
        $result = self::register($id, $in);
        if (is_wp_error($result)) { return $result; }
        $row = self::row($result['operation_id']);
        if ($row && $row['status'] === 'pending' && (int)$row['starts_at'] <= time()) {
            // Registration has committed and released its locks before the shared writer runs.
            self::process($row['id'], false);
            $latest = self::row($row['id']);
            if ($latest) { $result['promotion'] = self::publicRow($latest); }
        }
        // Success confirms durable plan registration; promotion status reports active/review/pending.
        return $result;
    }
    private static function register(int $id, mixed $in): array|\WP_Error {
        global $wpdb;
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !current_user_can('sdd_view_products') || !Policy::accessible($id, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์จัดการโปรสินค้านี้', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'Schema ไม่พร้อม', 503); }
        if (!is_array($in) || array_diff(array_keys($in), ['operation_id','price','start','end','baseline','confirmed','zero_ack','revive_expired']) || !self::uuid($in['operation_id'] ?? null) || !Policy::integer($in['price'] ?? null) || ($in['confirmed'] ?? false) !== true || !is_array($in['baseline'] ?? null) || array_keys($in['baseline']) !== ['regular_price','sale_price','sale_dates'] || count(array_filter($in['baseline'], 'is_string')) !== 3 || (($in['price'] ?? '') === '0' && ($in['zero_ack'] ?? false) !== true)) { return API::error('invalid_input', 'ต้องยืนยันราคาและข้อมูลโปรให้ครบ', 400); }
        if (array_key_exists('revive_expired', $in) && !is_bool($in['revive_expired'])) { return API::error('invalid_input', 'ตัวเลือกคืนโปรเดิมต้องเป็น boolean', 400); }
        $revive = $in['revive_expired'] ?? false;
        $start = self::parseTime($in['start'] ?? null); $end = self::parseTime($in['end'] ?? null);
        if ($start === null || $end === null || $end <= $start) { return API::error('invalid_dates', 'วันเวลาสิ้นสุดต้องหลังวันเวลาเริ่ม', 400); }
        $op = $in['operation_id']; $actor = get_current_user_id();
        $identity=[$actor,$id,$in['price'],$start,$end,$in['baseline']];
        if ($revive) { $identity[]=['revive_expired'=>true]; }
        $hash = hash('sha256', wp_json_encode($identity));
        $locks = []; $tx = false;
        try {
            $ids = [$id]; if (get_post_type($id) === 'product_variation') { $ids[] = (int)get_post_field('post_parent', $id); } sort($ids, SORT_NUMERIC);
            foreach (array_merge(['operation:'.$op], array_map(static fn($v) => 'product:'.$v, array_unique($ids))) as $key) {
                $lock = self::lock($key); if (!$lock) { return API::error('lock_timeout', 'ข้อมูลกำลังบันทึก ตรวจผลก่อนลองใหม่', 503); } $locks[] = $lock;
            }
            if ($existing = self::row($op)) {
                if ((int)$existing['actor_id'] !== $actor || !hash_equals($existing['payload_hash'], $hash)) { return API::error('operation_payload_mismatch', 'รหัสคำสั่งถูกใช้กับข้อมูลอื่น', 409); }
                self::schedule($existing); return ['ok'=>true,'promotion'=>self::publicRow($existing),'operation_id'=>$op];
            }
            if ($wpdb->get_var($wpdb->prepare('SELECT operation_id FROM ' . Schema::table('operations') . ' WHERE operation_id=%s', $op))) { return API::error('operation_payload_mismatch', 'รหัสคำสั่งถูกใช้แล้ว', 409); }
            if ($end <= time()) { return API::error('invalid_dates', 'เวลาจบต้องยังไม่ผ่าน หากเวลาเริ่มผ่านแล้วจะเริ่มทันที', 400); }
            $p = Writer::fresh($id);
            if (!$p || !Policy::accessible($id, true) || !in_array($p->get_type(), ['simple','variation'], true)) { return API::error('forbidden', 'ชนิดสินค้าไม่รองรับ', 403); }
            if ($reasons = Policy::fieldReasons($p, 'sale_price')) { return API::error('write_unavailable', implode('; ', $reasons), 503); }
            $base = self::snapshot($p);
            $originalEnd=explode('|',$base['sale_dates'])[1];
            if ($revive && (!self::hasOriginalSale($base) || $originalEnd==='' || (int)$originalEnd>max(time(),$end))) { return API::error('invalid_input','ใช้ตัวเลือกนี้ได้เมื่อมีโปรเดิมที่หมดอายุภายในช่วงโปรชั่วคราว',400); }
            if ($base !== $in['baseline']) { return API::error('field_conflict', 'ราคาเปลี่ยนแล้ว โหลดข้อมูลและยืนยันใหม่', 409); }
            if ((int)$in['price'] >= (int)$base['regular_price'] || ($base['sale_price'] !== '' && (int)$base['sale_price'] >= (int)$base['regular_price']) || ($base['sale_price'] === '' && $base['sale_dates'] !== '|') || is_wp_error(Policy::normalizeDates($base['sale_dates']))) { return API::error('price_relation', 'ราคาโปรใหม่และเดิมต้องต่ำกว่าราคาปกติ ตารางเดิมต้องถูกต้อง', 400); }
            if ((int)$in['price'] >= (int)self::reference($base, max(time(), $start))['price']) { return API::error('price_relation', 'ราคาโปรชั่วคราวต้องต่ำกว่าราคาปกติ', 400); }
            if ($wpdb->get_var($wpdb->prepare('SELECT id FROM ' . self::table() . " WHERE product_id=%d AND status IN ('pending','active','needs_review') LIMIT 1", $id))) { return API::error('promotion_exists', 'มีโปรที่รอเริ่ม/กำลังใช้/รอตรวจแล้ว ต้องปิดรายการเดิมก่อน', 409); }
            $now = gmdate('Y-m-d H:i:s');
            $row = ['id'=>$op,'product_id'=>$id,'actor_id'=>$actor,'payload_hash'=>$hash,'status'=>'pending','starts_at'=>$start,'ends_at'=>$end,'sale_price'=>$in['price'],'original_json'=>wp_json_encode($base),'expected_json'=>wp_json_encode(array_merge($base,['_revive_expired'=>$revive])),'start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'','created_at'=>$now,'updated_at'=>$now];
            if ($wpdb->query('START TRANSACTION') === false) { throw new \RuntimeException('Transaction failed.'); } $tx = true;
            $result = ['ok'=>true,'promotion'=>self::publicRow($row),'operation_id'=>$op]; $item = wp_generate_uuid4();
            foreach ([[self::table(),$row], [Schema::table('operations'),['operation_id'=>$op,'actor_id'=>$actor,'kind'=>'temporary_plan','payload_hash'=>$hash,'status'=>'completed','created_at'=>$now,'updated_at'=>$now]], [Schema::table('operation_items'),['item_id'=>$item,'operation_id'=>$op,'product_id'=>$id,'field'=>'temporary_sale','base_value'=>$base['sale_price'],'base_revision'=>Writer::revision($id,'sale_price'),'target_value'=>$in['price'],'status'=>'succeeded','canonical_result_json'=>wp_json_encode($result),'created_at'=>$now,'updated_at'=>$now]], [Schema::table('events'),['product_id'=>$id,'field'=>'temporary_sale','old_value'=>'','new_value'=>$op,'revision_before'=>0,'revision_after'=>0,'source'=>'temporary_sale_created','user_id'=>$actor,'operation_id'=>$op,'item_id'=>$item,'request_id'=>API::requestId(),'created_at'=>$now]]] as [$table,$data]) { if ($wpdb->insert($table,$data) === false) { throw new \RuntimeException('Plan registration failed.'); } }
            if ($wpdb->query('COMMIT') === false) { throw new \RuntimeException('Commit outcome unknown.'); } $tx = false;
            self::schedule($row); return $result;
        } catch (\Throwable $e) { API::log('writer_failure'); return API::error('operation_unknown', 'ตรวจผลคำสั่งก่อนส่งใหม่ ห้ามเปลี่ยนรหัสคำสั่ง', 409, ['operation_id'=>$op]); }
        finally { if ($tx) { $wpdb->query('ROLLBACK'); } self::unlock($locks); }
    }
    private static function schedule(array $r): void {
        if (!in_array($r['status'], ['pending','active'], true)) { return; }
        self::scheduleScan();
        foreach (['starts_at','ends_at'] as $key) {
            // Phase arguments keep start/end events distinct even when less than ten minutes apart.
            if ((int)$r[$key] > time()) { wp_schedule_single_event((int)$r[$key], 'sdd_temporary_sale_tick', [$r['id'], $key]); }
        }
    }
    public static function scan(): void {
        if (!Schema::ready()) { return; } global $wpdb;
        $ids = $wpdb->get_col($wpdb->prepare('SELECT id FROM ' . self::table() . " WHERE (status='pending' AND starts_at<=%d) OR (status='active' AND ends_at<=%d) ORDER BY ends_at ASC LIMIT 20", time(),time()));
        foreach ($ids as $id) { self::tick($id); }
        if (!self::hasLive()) { wp_clear_scheduled_hook('sdd_temporary_sale_scan'); }
    }
    public static function tick(string $id, string $phase = ''): void { self::process($id, false); }
    public static function cancel(int $productId, string $id, mixed $in): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !Policy::accessible($productId, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์ปิดโปร', 403); }
        if (!Schema::ready() || !is_array($in) || array_keys($in) !== ['confirmed'] || $in['confirmed'] !== true) { return API::error('invalid_input', 'ต้องยืนยันปิดรายการโปร', 400); }
        $r = self::row($id); if (!$r || (int)$r['product_id'] !== $productId) { return API::error('not_found','ไม่พบโปรสินค้านี้',404); }
        return self::process($id, true);
    }
    private static function process(string $id, bool $cancel): array|\WP_Error {
        if (!Schema::ready()) { return API::error('schema_unavailable','Schema ไม่พร้อม',503); }
        $lock = self::lock('promotion:'.$id); if (!$lock) { return API::error('lock_timeout','กำลังประมวลผลโปร',503); }
        $beforeActor = get_current_user_id();
        try {
            $r = self::row($id); if (!$r) { return API::error('not_found','ไม่พบโปร',404); }
            if (!in_array($r['status'],['pending','active','needs_review'],true)) { return ['ok'=>true,'promotion'=>self::publicRow($r)]; }
            if ($cancel && $r['status'] !== 'active') { self::update($id,['status'=>'cancelled','message'=>$r['status']==='needs_review'?'ปิดรายการตรวจสอบแล้ว คงราคาปัจจุบัน':'ยกเลิกก่อนเริ่ม']); return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))]; }
            if ($r['status'] === 'needs_review') { return API::error('needs_review',$r['message'],409); }
            if (!$cancel && (($r['status']==='pending' && (int)$r['starts_at']>time()) || ($r['status']==='active' && (int)$r['ends_at']>time()))) { return ['ok'=>true,'promotion'=>self::publicRow($r)]; }
            if ($r['status']==='pending' && (int)$r['ends_at']<=time()) { self::update($id,['status'=>'needs_review','message'=>'เลยเวลาจบก่อนเริ่ม ไม่เปลี่ยนราคา กรุณาตรวจสอบและปิดรายการ']); return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))]; }
            if ($reasons=Policy::globalReasons()) { self::update($id,['message'=>implode('; ',$reasons).' — รอประมวลผล รวมถึงการคืนราคา']); return API::error('write_unavailable',implode('; ',$reasons),503); }
            wp_set_current_user((int)$r['actor_id']);
            $pid=(int)$r['product_id'];
            if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !current_user_can('sdd_view_products') || !Policy::accessible($pid,true)) { self::update($id,['status'=>'needs_review','message'=>'ผู้สร้างโปรไม่มีสิทธิ์แก้สินค้าแล้ว หยุดอัตโนมัติ']); return API::error('needs_review','สิทธิ์ผู้สร้างโปรเปลี่ยน ต้องตรวจสอบ',409); }
            $storedExpected=json_decode($r['expected_json'],true); $expected=array_intersect_key($storedExpected,array_flip(['regular_price','sale_price','sale_dates'])); $original=json_decode($r['original_json'],true); $starting=$r['status']==='pending';
            $nativeEnded=$original; $nativeEnded['sale_price']=''; $nativeEnded['sale_dates']='|';
            if ($starting && $expected!==$original && $expected!==$nativeEnded) { self::update($id,['status'=>'needs_review','message'=>'ข้อมูลราคาเดิมเปลี่ยน ต้องตรวจสอบก่อนเริ่ม']); return API::error('needs_review','ข้อมูลราคาเดิมเปลี่ยน ต้องตรวจสอบ',409); }
            $reference=$starting?self::reference($original,time())['price']:($storedExpected['_reference_price']??self::reference($original,(int)$r['starts_at'])['price']);
            if ($starting && (int)$r['sale_price'] >= (int)$reference) { self::update($id,['status'=>'needs_review','message'=>'ราคาโปรชั่วคราวไม่ต่ำกว่าราคาที่มีผลก่อนเริ่ม ต้องตรวจสอบ']); return API::error('needs_review','ราคาอ้างอิงเปลี่ยน ต้องตรวจสอบ',409); }
            $effective = Writer::fresh($pid);
            if (!$starting && (!$effective || $effective->get_price('edit') !== $expected['sale_price'])) { self::update($id,['status'=>'needs_review','message'=>'ราคาที่แสดงเปลี่ยนจากโปรชั่วคราว หยุดคืนอัตโนมัติ']); return API::error('needs_review','ราคาที่แสดงเปลี่ยน ต้องตรวจสอบ',409); }
            $target=$starting?['sale_price'=>$r['sale_price'],'sale_dates'=>'|']:array_intersect_key($original,array_flip(['sale_price','sale_dates']));
            $originalEnd=explode('|',$original['sale_dates'])[1];
            $revived=!$starting && ($storedExpected['_revive_expired']??false) && self::hasOriginalSale($original) && $originalEnd!=='' && (int)$originalEnd<=time();
            // A stored zero original sale means no original promotion; clear it on restoration.
            if (!$starting && !self::hasOriginalSale($original)) { $target=['sale_price'=>'','sale_dates'=>'|']; }
            if ($revived) { $target['sale_dates']='|'; }
            $op=$starting?$r['start_operation']:$r['end_operation'];
            $input=['operation_id'=>$op,'field'=>'sale_price','base_value'=>$expected['sale_price'],'base_revision'=>Writer::revision($pid,'sale_price'),'value'=>$target['sale_price'],'acknowledgements'=>['price_change','zero_price','expired_schedule']];
            // Exclude hooks for this product only; other product changes still trigger review.
            self::$ownProduct=$pid;
            $result=Writer::transition($pid,$input,['expected'=>$expected,'target'=>$target,'promotion'=>$id,'source'=>$starting?'temporary_start':'temporary_restore',
                'guard'=>static fn()=> (self::row($id)['status']??'')===$r['status'] && (!$starting || self::reference($original,time())['price']===$reference),
                'record'=>static function($values)use($id,$starting,$cancel,$r,$reference,$storedExpected,$revived){ self::updateState($id,$r['status'],['status'=>$starting?'active':($cancel?'cancelled':'restored'),'expected_json'=>wp_json_encode(array_merge(array_intersect_key($values,array_flip(['regular_price','sale_price','sale_dates'])),['_reference_price'=>$reference,'_revive_expired'=>(bool)($storedExpected['_revive_expired']??false)])),'message'=>$starting?'โปรชั่วคราวกำลังใช้':($revived?'คืนราคาโปรเดิมและล้างวันหมดอายุแล้ว':($cancel?'ยุติโปรและคืนตารางเดิมแล้ว':'คืนราคาและตารางโปรเดิมแล้ว'))]); }
            ]);
            if (is_wp_error($result)) { self::update($id,['status'=>'needs_review','message'=>'หยุดอัตโนมัติ: '.$result->get_error_code().' กรุณาตรวจราคาและ audit ก่อนปิดรายการ']); return $result; }
            return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))];
        } catch (\Throwable $e) { API::log('writer_failure'); return API::error('operation_unknown','ไม่ยืนยันผลโปร ต้องตรวจสอบก่อนทำต่อ',409); }
        finally { self::$ownProduct=0; wp_set_current_user($beforeActor); self::unlock([$lock]); }
    }
}
