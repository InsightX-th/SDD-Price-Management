<?php
declare(strict_types=1);
namespace SDD;

/** Operational reads never reconcile, reset or change business state. */
final class Inspection {
    private static function loggerStatus(): array {
        if (!class_exists('Automattic\\WooCommerce\\Utilities\\LoggingUtil')) { return ['state'=>'unavailable','detail'=>'WooCommerce ยังไม่พร้อมให้ตรวจระบบบันทึกเหตุการณ์']; }
        try {
            $util='Automattic\\WooCommerce\\Utilities\\LoggingUtil';
            $enabled=$util::logging_is_enabled();$handler=$util::get_default_handler();$retention=$util::get_retention_period();$threshold=$util::get_level_threshold();
            $directory=$util::get_log_directory(false);$real=is_string($directory)?realpath($directory):false;
            $root=realpath(ABSPATH);$inside=$real&&$root&&str_starts_with($real,rtrim($root,DIRECTORY_SEPARATOR).DIRECTORY_SEPARATOR);
            $writable=$real&&is_dir($real)&&is_writable($real);
            $fileHandler=str_contains($handler,'LogHandlerFileV2')||$handler==='WC_Log_Handler_File';
            $protected=$real&&is_file($real.'/.htaccess')&&is_file($real.'/index.html');
            $state='warning';
            $handlerName=$handler==='WC_Log_Handler_File'?'file_legacy':(str_contains($handler,'LogHandlerFileV2')?'file_v2':(str_contains($handler,'DB')?'database':'custom'));
            $location=$real&&$root?($inside?'อยู่ใต้ web root':'อยู่นอก web root'):'ระบุตำแหน่งเทียบ web root ไม่ได้';
            $detail=($enabled?'เปิด':'ปิด').' · '.$handlerName.' · retention '.$retention.' วัน · '.($writable?'บันทึกไฟล์ได้':'ยังบันทึกไฟล์ไม่ได้').' · '.$location;
            $detail.=' · ไฟล์ป้องกันโฟลเดอร์ '.($protected?'พบ':'ไม่ครบ');
            $detail.=' · '.($threshold==='none'?'WooCommerce ไม่จำกัด threshold':'threshold '.$threshold);
            $detail.=' · ลดการบันทึกถี่เกิน 10 ครั้งต่อนาที และจำกัดไม่เกิน 100 ครั้งต่อวัน';
            $detail.=' · ยังต้องตรวจว่าไฟล์ถูกป้องกันจากการเปิดผ่าน URL';
            return ['state'=>$state,'detail'=>$detail,'logging_enabled'=>$enabled,'handler'=>$handlerName,'retention_days'=>$retention,'directory_writable'=>(bool)$writable,'outside_web_root'=>$real&&$root?(bool)!$inside:null,'directory_guard_files'=>(bool)$protected,'http_access'=>'unverified','daily_budget'=>'100_per_utc_day'];
        } catch (\Throwable $e) { return ['state'=>'unavailable','detail'=>'อ่านการตั้งค่าบันทึกเหตุการณ์ไม่ได้ กรุณาลองอีกครั้งหรือติดต่อผู้ดูแล']; }
    }
    private static function sample(string $table, string $condition, string $order): array {
        global $wpdb;
        $rows = $wpdb->get_col('SELECT 1 FROM ' . Schema::table($table) . ' WHERE ' . $condition . ' ORDER BY ' . $order . ' LIMIT 101');
        if ($wpdb->last_error) { return ['count'=>null,'at_least'=>false,'state'=>'unavailable']; }
        return ['count'=>min(100,count($rows)), 'at_least'=>count($rows)>100, 'state'=>'available'];
    }
    public static function health(array $query = []): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if ($query) { return API::error('invalid_query','สถานะระบบไม่รับตัวกรอง',400); }
        global $wpdb;
        $ready=Schema::ready();$reasons=Policy::globalReasons();$enableReasons=Policy::enableReasons();$queues=[];
        if ($ready) {
            $stalled=$wpdb->prepare("(status IN ('running','processing') AND updated_at<%s) OR status='unknown'",gmdate('Y-m-d H:i:s',time()-300));
            $queues['unresolved_operations']=self::sample('operations',$stalled,'status,updated_at');
            $queues['external_pending']=self::sample('external_observations','event_id IS NULL','event_id,id');
            $queues['promotions_review']=self::sample('temporary_sales',"status='needs_review'",'status,starts_at,ends_at');
            $queues['live_promotions']=self::sample('temporary_sales',"status IN ('pending','active')",'status,starts_at,ends_at');
        }
        $logger=self::loggerStatus();
        $checks=[
            ['key'=>'schema','label'=>'โครงสร้างฐานข้อมูล','state'=>$ready?'ok':'blocked','detail'=>$ready?'พร้อม · ฐานข้อมูลรุ่น '.Schema::VERSION:'ฐานข้อมูลยังไม่พร้อม จึงหยุดการบันทึกไว้'],
            ['key'=>'writer','label'=>'เงื่อนไขการบันทึก','state'=>$ready&&!$reasons?'ok':'blocked','detail'=>$ready&&!$reasons?'พร้อมบันทึก โดยตรวจสิทธิ์และข้อจำกัดของสินค้าแต่ละรายการอีกครั้ง':implode(' · ',$reasons?:['ฐานข้อมูลยังไม่พร้อม'])],
            ['key'=>'cache','label'=>'Object cache','state'=>wp_using_ext_object_cache()?'blocked':'ok','detail'=>wp_using_ext_object_cache()?'พบระบบแคชข้อมูลถาวร (Object cache) ซึ่งปลั๊กอินรุ่นนี้ยังไม่รองรับ':'ใช้ cache ปกติของ WordPress'],
            ['key'=>'logger','label'=>'Technical log','state'=>$logger['state'],'detail'=>$logger['detail']],
        ];
        foreach ($queues as $key=>$sample) {
            if ($sample['state']==='unavailable') { $checks[]=['key'=>$key,'label'=>'ตรวจคิวงาน','state'=>'warning','detail'=>'อ่านสถานะคิวไม่สำเร็จ ไม่ถือว่าคิวว่าง']; }
        }
        if (($queues['unresolved_operations']['count']??0)>0) { $checks[]=['key'=>'unresolved','label'=>'คำสั่งที่ยังยืนยันผลไม่ได้','state'=>'warning','detail'=>'ให้ผู้ดูแลตรวจผลรายการเดิมก่อนบันทึกอีกครั้ง เพื่อป้องกันการบันทึกซ้ำ']; }
        if (($queues['promotions_review']['count']??0)>0) { $checks[]=['key'=>'review','label'=>'โปรที่ต้องตรวจสอบ','state'=>'warning','detail'=>'บางโปรหยุดคืนราคาอัตโนมัติแล้ว ให้ตรวจราคาปัจจุบันและประวัติของสินค้า']; }
        $cron=[];
        foreach (['sdd_feed_publish','sdd_external_drain','sdd_temporary_sale_scan','sdd_log_retention','sdd_business_retention'] as $hook) {
            $next=wp_next_scheduled($hook);$required=$hook!=='sdd_temporary_sale_scan'||($queues['live_promotions']['count']??0)>0;
            $state=!$next?($required?'warning':'idle'):($next<time()-300?'warning':'scheduled');
            $cron[]=['job'=>$hook,'next_at'=>$next?gmdate('c',$next):null,'state'=>$state];
        }
        return ['version'=>SDD_VERSION,'schema_version'=>Schema::VERSION,'runtime'=>['php'=>PHP_VERSION,'wordpress'=>$GLOBALS['wp_version'],'woocommerce'=>defined('WC_VERSION')?WC_VERSION:null,'timezone'=>wp_timezone_string()], 'checks'=>$checks,'enable_reasons'=>$enableReasons,'production_verified'=>false,'queues'=>$queues,'cron'=>$cron,'wp_cron_disabled'=>defined('DISABLE_WP_CRON')&&DISABLE_WP_CRON,'cron_note'=>'เวลาที่แสดงเป็นกำหนดการ ยังไม่ใช่ผลทำงานสำเร็จ งานอัตโนมัติต้องมีผู้เข้าเว็บหรือระบบเรียกงานของเซิร์ฟเวอร์','server_time'=>gmdate('c')];
    }
    public static function audit(array $query): array|\WP_Error {
        if (!current_user_can('sdd_view_products') || !current_user_can('sdd_view_audit')) { return API::error('forbidden','สิทธิ์ดูประวัติไม่เพียงพอ',403); }
        if (array_diff(array_keys($query),['product_id','field','before','per_page'])) { return API::error('invalid_query','ตัวกรองประวัติไม่ถูกต้อง',400); }
        $id=$query['product_id']??'';$before=$query['before']??'';$field=$query['field']??'';$size=$query['per_page']??'20';
        if (!is_string($id)||!preg_match('/^[1-9][0-9]{0,17}$/D',$id)||!is_string($before)||($before!==''&&!preg_match('/^[1-9][0-9]{0,17}$/D',$before))||!is_string($field)||($field!==''&&!in_array($field,Policy::FIELDS,true))||!is_string($size)||!in_array($size,['20','50'],true)) { return API::error('invalid_query','ระบุ ID สินค้าและตัวกรองประวัติให้ถูกต้อง',400); }
        if (!Policy::accessible((int)$id)) { return API::error('not_found','ไม่พบสินค้าที่มีสิทธิ์ดู',404); }
        if (!Schema::ready()) { return API::error('schema_unavailable','ฐานข้อมูลยังไม่พร้อม',503); }
        global $wpdb;
        $where=$wpdb->prepare('e.product_id=%d',(int)$id);
        if ($field!=='') { $where.=$wpdb->prepare(' AND e.field=%s',$field); }
        if ($before!=='') { $where.=$wpdb->prepare(' AND e.id<%d',(int)$before); }
        $rows=$wpdb->get_results('SELECT e.id,e.product_id,e.field,e.old_value,e.new_value,e.revision_before,e.revision_after,e.source,e.user_id,e.operation_id,e.request_id,e.reverts_event_id,e.created_at,u.user_login AS actor_login,u.user_email AS actor_email FROM '.Schema::table('events').' e LEFT JOIN '.$wpdb->users.' u ON u.ID=e.user_id WHERE '.$where.' ORDER BY e.id DESC LIMIT '.((int)$size+1),ARRAY_A);
        if ($wpdb->last_error) { return API::error('audit_unavailable','อ่านประวัติไม่สำเร็จ กรุณาลองใหม่',503); }
        $more=count($rows)>(int)$size;$rows=array_slice($rows,0,(int)$size);
        $items=array_map(static function(array $row):array {
            foreach (['id','product_id','revision_before','revision_after'] as $key) { $row[$key]=(string)$row[$key]; }
            foreach (['user_id','reverts_event_id','actor_login','actor_email'] as $key) { $row[$key]=$row[$key]===null?null:(string)$row[$key]; }
            $row['created_at']=str_replace(' ','T',$row['created_at']).'Z';return $row;
        },$rows);
        $product=wc_get_product((int)$id);
        return ['product'=>['id'=>$id,'name'=>$product?$product->get_name():$id],'items'=>$items,'next_before'=>$more?(string)end($rows)['id']:null,'per_page'=>(int)$size,'server_time'=>gmdate('c')];
    }
}
