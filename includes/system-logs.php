<?php
declare(strict_types=1);
namespace SDD;

/** Bounded, source-scoped access to WooCommerce's technical logs. */
final class SystemLogs {
    public const SOURCE = 'sdd-stock-price';
    private const EVENTS = ['writer_failure','schema_failure','publication_failure','external_observation_failure','external_reduction_failure'];
    private const MAX_FILE_BYTES = 5242880;
    private const RETENTION_DAYS = 30;
    private const DAILY_EMISSION_LIMIT = 100;
    private static mixed $budgetConnection = null;

    public static function boot(): void {
        add_action('sdd_log_retention', [self::class, 'prune']);
        add_action('init', static function(): void { if (!wp_next_scheduled('sdd_log_retention')) { wp_schedule_event(time()+300, 'daily', 'sdd_log_retention'); } });
        add_action('admin_init', static function(): void {
            if (current_user_can('manage_options') && get_option('sdd_p5_log_caps') !== '1') {
                $role = get_role('administrator');
                if ($role) { $role->add_cap('sdd_view_system_logs'); update_option('sdd_p5_log_caps', '1', false); wp_get_current_user()->get_role_caps(); }
            }
            if (current_user_can('manage_options') && !wp_next_scheduled('sdd_log_retention')) { wp_schedule_event(time()+300, 'daily', 'sdd_log_retention'); }
        });
        add_filter('woocommerce_logger_delete_expired_file', [self::class, 'protectRecentFiles'], 10, 3);
    }

    private static function controller(): mixed {
        if (!class_exists('Automattic\\WooCommerce\\Utilities\\LoggingUtil') || !function_exists('wc_get_container')) { return API::error('logs_unavailable','ระบบบันทึกเหตุการณ์ไม่พร้อม',503); }
        try {
            $class = 'Automattic\\WooCommerce\\Internal\\Admin\\Logging\\FileV2\\FileController';
            if (!class_exists($class)) { return API::error('logs_unavailable','WooCommerce รุ่นนี้ยังไม่รองรับการอ่าน log แบบจำกัด source',503); }
            return wc_get_container()->get($class);
        } catch (\Throwable) { return API::error('logs_unavailable','อ่านระบบบันทึกเหตุการณ์ไม่ได้',503); }
    }

    public static function listing(array $query = []): array|\WP_Error {
        if ($query) { return API::error('invalid_query','ไม่รองรับตัวกรอง log',400); }
        $controller = self::controller(); if (is_wp_error($controller)) { return $controller; }
        try { $files = $controller->get_files(['source'=>self::SOURCE,'orderby'=>'created','order'=>'desc','per_page'=>50,'offset'=>0]); }
        catch (\Throwable) { return API::error('logs_unavailable','อ่านรายการ log ไม่สำเร็จ',503); }
        if (is_wp_error($files) || !is_array($files)) { return API::error('logs_unavailable','อ่านรายการ log ไม่สำเร็จ',503); }
        $items=[];
        foreach ($files as $file) {
            if (!is_object($file) || !method_exists($file,'get_source') || $file->get_source() !== self::SOURCE || !method_exists($file,'get_file_id')) { continue; }
            $id=(string)$file->get_file_id();
            if (!self::validId($id)) { continue; }
            $items[]=['id'=>$id,'created_at'=>gmdate('c',(int)$file->get_created_timestamp()),'size_bytes'=>min(self::MAX_FILE_BYTES,(int)$file->get_file_size()),'readable'=>(bool)$file->is_readable()];
        }
        return ['items'=>$items,'retention_days'=>self::RETENTION_DAYS,'per_page'=>50];
    }

    private static function validId(string $id): bool { return strlen($id)<=120 && preg_match('/^[a-z0-9_.-]+$/D',$id)===1 && !str_contains($id,'..'); }

    /** Cross-request and transaction-independent hard daily cap, backed by one atomic options-row update. */
    public static function claimLogEmission(): bool {
        global $wpdb;
        $key='sdd_log_budget_'.gmdate('Ymd');
        try {
            $db=self::$budgetConnection;
            if (!$db || !$db->dbh) { $db=new \wpdb(DB_USER,DB_PASSWORD,DB_NAME,DB_HOST);$db->suppress_errors(true);$db->set_prefix($wpdb->prefix);self::$budgetConnection=$db; }
            if (!$db->dbh || $db->dbh===$wpdb->dbh) { return false; }
            $table=$db->options;
            if ($db->query($db->prepare("INSERT IGNORE INTO $table (option_name,option_value,autoload) VALUES (%s,'0','no')",$key))===false) { return false; }
            $updated=$db->query($db->prepare("UPDATE $table SET option_value=CAST(option_value AS UNSIGNED)+1 WHERE option_name=%s AND CAST(option_value AS UNSIGNED)<%d",$key,self::DAILY_EMISSION_LIMIT));
            return $updated===1;
        } catch (\Throwable) { return false; }
    }

    public static function read(string $id): array|\WP_Error {
        if (!self::validId($id)) { return API::error('invalid_log','ไม่พบไฟล์ log',404); }
        $controller=self::controller(); if (is_wp_error($controller)) { return $controller; }
        try { $file=$controller->get_file_by_id($id); } catch (\Throwable) { return API::error('logs_unavailable','อ่านไฟล์ log ไม่สำเร็จ',503); }
        if (is_wp_error($file) || !is_object($file) || !method_exists($file,'get_source') || $file->get_source()!==self::SOURCE || !$file->is_readable()) { return API::error('not_found','ไม่พบไฟล์ log ที่มีสิทธิ์ดู',404); }
        $path=$file->get_path(); $directory=\Automattic\WooCommerce\Internal\Admin\Logging\Settings::get_log_directory(false);
        $real=realpath($path);$root=realpath($directory);
        if (!$real || !$root || !is_file($real) || !str_starts_with($real,rtrim($root,DIRECTORY_SEPARATOR).DIRECTORY_SEPARATOR) || filesize($real)>self::MAX_FILE_BYTES) { return API::error('log_unavailable','ไฟล์ log ใหญ่เกินขอบเขตหรืออ่านไม่ได้',413); }
        $stream=$file->get_stream(); if (!is_resource($stream)) { return API::error('log_unavailable','อ่านไฟล์ log ไม่ได้',503); }
        $items=[];$scanned=0;
        try {
            while (!feof($stream) && $scanned<10000 && count($items)<200) {
                $line=fgets($stream,4096); if ($line===false) { break; } $scanned++;
                $entry=self::parseLine($line); if ($entry) { $items[]=$entry; }
            }
        } finally { if (method_exists($file,'close_stream')) { $file->close_stream(); } }
        return ['id'=>$id,'created_at'=>gmdate('c',(int)$file->get_created_timestamp()),'items'=>array_reverse($items),'truncated'=>$scanned>=10000 || count($items)>=200];
    }

    /** Return only normalized fields; never echo a raw line or arbitrary WooCommerce context. */
    public static function parseLine(string $line): ?array {
        $line=rtrim($line,"\r\n");
        if (strlen($line)>4095 || !preg_match('/^(?<time>\[[^\]]{1,40}\]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(?<level>ERROR|CRITICAL|ALERT|EMERGENCY|WARNING)\s+(?<message>[^\r\n]*)\z/',$line,$m)) { return null; }
        if (!preg_match('/^(?<code>[a-z_]{3,64})(?:\s+CONTEXT:\s*(?<context>\{[^\r\n]{0,1024}\}))?\z/',trim($m['message']),$message)) { return null; }
        if (!in_array($message['code'],self::EVENTS,true)) { return null; }
        $requestId=null;
        if (!empty($message['context'])) {
            $context=json_decode($message['context'],true);
            if (!is_array($context) || array_diff(array_keys($context),['request_id']) || !is_string($context['request_id']??null) || !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D',$context['request_id'])) { return null; }
            $requestId=$context['request_id'];
        }
        $timestamp=strtotime(trim($m['time'],'[]')); if ($timestamp===false) { return null; }
        return ['occurred_at'=>gmdate('c',$timestamp),'level'=>$m['level'],'event'=>$message['code'],'request_id'=>$requestId];
    }

    /** Keep WooCommerce's global cleanup from deleting this source before its own 30-day policy. */
    public static function protectRecentFiles(bool $delete, mixed $file, int $threshold): bool {
        if (is_object($file) && method_exists($file,'get_source') && $file->get_source()===self::SOURCE && method_exists($file,'get_created_timestamp')) {
            return $delete && (int)$file->get_created_timestamp() < time()-self::RETENTION_DAYS*DAY_IN_SECONDS;
        }
        return $delete;
    }

    /** Delete at most 100 old files each run; each candidate is checked for an exact source match. */
    public static function prune(): int {
        $controller=self::controller(); if (is_wp_error($controller)) { return 0; }
        $cutoff=time()-self::RETENTION_DAYS*DAY_IN_SECONDS;$deleted=0;$offset=0;$scanned=0;
        try {
            do {
                $files=$controller->get_files(['source'=>self::SOURCE,'orderby'=>'created','order'=>'asc','date_filter'=>'created','date_start'=>1,'date_end'=>$cutoff,'per_page'=>100,'offset'=>$offset]);
                if (is_wp_error($files)||!is_array($files)||!$files) { break; }
                foreach ($files as $file) {
                    $scanned++;
                    if (is_object($file)&&method_exists($file,'get_source')&&$file->get_source()===self::SOURCE&&method_exists($file,'get_created_timestamp')&&(int)$file->get_created_timestamp()<$cutoff&&$file->delete()) { $deleted++; }
                    if ($deleted>=100||$scanned>=500) { break 2; }
                }
                $offset+=count($files);
            } while (count($files)===100);
        } catch (\Throwable) { return $deleted; }
        global $wpdb;
        $budgetTable=$wpdb->options;$keep='sdd_log_budget_'.gmdate('Ymd',time()-40*DAY_IN_SECONDS);
        $wpdb->query($wpdb->prepare("DELETE FROM $budgetTable WHERE LEFT(option_name,15)='sdd_log_budget_' AND option_name < %s",$keep));
        return $deleted;
    }
}
