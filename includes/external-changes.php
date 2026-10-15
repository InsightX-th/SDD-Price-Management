<?php
declare(strict_types=1);
namespace SDD;
/** Hook observations are not a transaction wrapper around external product writers. */
final class ExternalChanges {
    private const KEYS=['_regular_price'=>'regular_price','_sale_price'=>'sale_price','_stock_status'=>'stock_status','_sale_price_dates_from'=>'sale_dates','_sale_price_dates_to'=>'sale_dates'];
    private static array $before=[];
    private static array $creating=[];
    private static bool $booted=false;
    public static function boot(): void {
        if (self::$booted) { return; } self::$booted=true;
        add_action('woocommerce_before_product_object_save',static function($p):void { if (!$p->get_id()) { self::$creating[spl_object_id($p)]=true; } },1);
        add_action('woocommerce_after_product_object_save',static function($p):void { unset(self::$creating[spl_object_id($p)]); },PHP_INT_MAX);
        add_action('add_post_meta',static fn($id,$key)=>self::before((int)$id,(string)$key),1,2);
        foreach (['update_post_meta','delete_post_meta'] as $hook) { add_action($hook,static fn($meta,$id,$key)=>self::before((int)$id,(string)$key),1,3); }
        foreach (['added_post_meta','updated_post_meta','deleted_post_meta'] as $hook) { add_action($hook,static fn($meta,$id,$key)=>self::after((int)$id,(string)$key),1,3); }
        add_action('sdd_external_drain',[self::class,'scan']);
        add_action('admin_init',[self::class,'schedule']);
    }
    public static function schedule(): void {
        if (current_user_can('sdd_manage_settings')&&Schema::ready()&&!wp_next_scheduled('sdd_external_drain')) { wp_schedule_event(time()+60,'sdd_minute','sdd_external_drain'); }
    }
    private static function eligible(int $id,string $key): bool {
        if (!isset(self::KEYS[$key])||Writer::active()||self::$creating||get_option('sdd_schema_version')!==Schema::VERSION||wp_using_ext_object_cache()) { return false; }
        return get_post_status($id)==='publish'&&in_array(\WC_Product_Factory::get_product_type($id),['simple','variation'],true);
    }
    /** SQL only; reading an object here could reflect a stale or partially saved object. */
    private static function values(int $id,\wpdb $db): array {
        global $wpdb;
        $rows=$db->get_results($db->prepare("SELECT meta_key,meta_value FROM $wpdb->postmeta WHERE post_id=%d AND meta_key IN ('_regular_price','_sale_price','_stock_status','_sale_price_dates_from','_sale_price_dates_to') ORDER BY meta_id",$id),ARRAY_A);
        if ($db->last_error) { throw new \RuntimeException('External values unavailable.'); }
        $meta=[];foreach ($rows as $row) { if (!array_key_exists($row['meta_key'],$meta)) { $meta[$row['meta_key']]=$row['meta_value']; } }
        $date=static fn($key)=>(!empty($meta[$key])?(string)$meta[$key]:'');
        return ['regular_price'=>(string)($meta['_regular_price']??''),'sale_price'=>(string)($meta['_sale_price']??''),'stock_status'=>(string)($meta['_stock_status']??'instock'),'sale_dates'=>$date('_sale_price_dates_from').'|'.$date('_sale_price_dates_to')];
    }
    private static function gap(): void {
        update_option('sdd_external_observation_gap',['code'=>'observation_failed','detected_at'=>gmdate('c')],false);
        API::log('external_observation_failure');
    }
    private static function before(int $id,string $key): void {
        if (!self::eligible($id,$key)) { return; }
        global $wpdb;
        try { self::$before[$id.':'.$key]=self::values($id,$wpdb)[self::KEYS[$key]]; }
        catch (\Throwable $e) { self::gap(); }
    }
    private static function after(int $id,string $key): void {
        $identity=$id.':'.$key;
        if (!array_key_exists($identity,self::$before)) { return; }
        $old=self::$before[$identity];unset(self::$before[$identity]);
        if (!self::eligible($id,$key)) { return; }
        global $wpdb;
        try {
            $field=self::KEYS[$key];$new=self::values($id,$wpdb)[$field];
            if ($old===$new) { return; }
            if (strlen($old)>64||strlen($new)>64) { throw new \RuntimeException('External value bounds.'); }
            $source=doing_action('wc_product_start_scheduled_sale')||doing_action('wc_product_end_scheduled_sale')||doing_action('woocommerce_scheduled_sales')?'woo_schedule':'external_hook';
            if ($wpdb->insert(Schema::table('external_observations'),['product_id'=>$id,'field'=>$field,'old_value'=>$old,'new_value'=>$new,'source'=>$source,'request_id'=>API::requestId(),'created_at'=>gmdate('Y-m-d H:i:s')])===false) { throw new \RuntimeException('Observation insert failed.'); }
        } catch (\Throwable $e) { self::gap(); }
    }
    /** Trusted reducer, called ONLY with caller-owned product lock+transaction. Returns backlog. */
    public static function apply(int $id,\wpdb $db,array $values): bool {
        $queue=Schema::table('external_observations');$events=Schema::table('events');$states=Schema::table('field_state');
        $rows=$db->get_results($db->prepare("SELECT * FROM $queue WHERE product_id=%d AND event_id IS NULL ORDER BY id LIMIT 200 FOR UPDATE",$id),ARRAY_A);
        if ($db->last_error) { throw new \RuntimeException('Observation read failed.'); }
        foreach ($rows as $row) {
            $f=$row['field'];
            if (!in_array($f,Policy::FIELDS,true)||!isset($values[$f])) { throw new \RuntimeException('Observation invalid field.'); }
            if ($db->query($db->prepare("INSERT IGNORE INTO $states (product_id,field,revision,last_known_value,updated_at) VALUES (%d,%s,0,%s,%s)",$id,$f,$values[$f],gmdate('Y-m-d H:i:s')))===false) { throw new \RuntimeException('External state baseline failed.'); }
            $s=$db->get_row($db->prepare("SELECT * FROM $states WHERE product_id=%d AND field=%s FOR UPDATE",$id,$f),ARRAY_A);
            if (!$s||$db->last_error||(int)$s['revision']>=999999999999999999) { throw new \RuntimeException('External revision failed.'); }
            $next=(int)$s['revision']+1;
            if ($db->insert($events,['product_id'=>$id,'field'=>$f,'old_value'=>$row['old_value'],'new_value'=>$row['new_value'],'revision_before'=>$s['revision'],'revision_after'=>$next,'source'=>$row['source'],'request_id'=>$row['request_id'],'created_at'=>$row['created_at']])===false) { throw new \RuntimeException('External audit failed.'); }
            $event=$db->insert_id;
            if ($db->update($states,['revision'=>$next,'last_known_value'=>$values[$f],'last_event_id'=>$event,'updated_at'=>gmdate('Y-m-d H:i:s')],['product_id'=>$id,'field'=>$f])===false||$db->update($queue,['event_id'=>$event],['id'=>$row['id'],'event_id'=>null])!==1) { throw new \RuntimeException('External link failed.'); }
        }
        $pending=$db->get_var($db->prepare("SELECT id FROM $queue WHERE product_id=%d AND event_id IS NULL LIMIT 1",$id));
        if ($db->last_error) { throw new \RuntimeException('Observation backlog read failed.'); }
        return $pending!==null;
    }
    /** At most 20 products per cycle; independent connection never commits external writes. */
    public static function drain(array $ids): bool {
        if (!Schema::ready()) { return false; }
        $db=null;$locked=false;$transaction=false;$lock='';
        try {
            $db=new \wpdb(DB_USER,DB_PASSWORD,DB_NAME,DB_HOST);$db->suppress_errors(true);
            global $wpdb;if (!$db->dbh||$db->dbh===$wpdb->dbh) { return false; }
            if ($db->query('SET SESSION innodb_lock_wait_timeout=1')===false) { throw new \RuntimeException('External connection failed.'); }
            $ids=array_slice(array_values(array_unique(array_filter(array_map('intval',$ids),static fn($id)=>$id>0))),0,100);
            if (!$ids) { return true; }
            $slots=implode(',',array_fill(0,count($ids),'%d'));
            $pending=$db->get_col($db->prepare('SELECT product_id FROM '.Schema::table('external_observations')." WHERE event_id IS NULL AND product_id IN ($slots) GROUP BY product_id ORDER BY MIN(id) LIMIT 20",...$ids));
            if ($db->last_error) { throw new \RuntimeException('Observation pending failed.'); }
            foreach (array_map('intval',$pending) as $id) {
                $lock=Writer::productLock($id);
                if ((string)$db->get_var($db->prepare('SELECT GET_LOCK(%s,0)',$lock))!=='1') { continue; } $locked=true;
                if ($db->query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')===false||$db->query('START TRANSACTION')===false) { throw new \RuntimeException('Observation transaction failed.'); } $transaction=true;
                self::apply($id,$db,self::values($id,$db));
                if ($db->query('COMMIT')===false) { throw new \RuntimeException('Observation commit unknown.'); } $transaction=false;
                $db->get_var($db->prepare('SELECT RELEASE_LOCK(%s)',$lock));$locked=false;
            }
            return true;
        } catch (\Throwable $e) { API::log('external_reduction_failure');return false; }
        finally { if ($db) { if ($transaction) { $db->query('ROLLBACK'); } if ($locked) { $db->get_var($db->prepare('SELECT RELEASE_LOCK(%s)',$lock)); } $db->close(); } }
    }
    public static function scan(): void {
        if (!Schema::ready()) { return; } global $wpdb;
        $ids=$wpdb->get_col('SELECT product_id FROM '.Schema::table('external_observations').' WHERE event_id IS NULL GROUP BY product_id ORDER BY MIN(id) LIMIT 20');
        self::drain($ids);Feed::publish();
    }
}
