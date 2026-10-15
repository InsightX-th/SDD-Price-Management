<?php
declare(strict_types=1);
namespace SDD;

/** Bounded 90-day cleanup for resolved plugin audit/operation data. */
final class Retention {
    private const DAYS=90;
    private const OPERATION_BATCH=25;
    private const EVENT_BATCH=100;

    public static function boot():void {
        add_action('sdd_business_retention',[self::class,'prune']);
        add_action('init',[self::class,'schedule']);
        if(did_action('init')){self::schedule();}
    }

    public static function schedule():void { if(!wp_next_scheduled('sdd_business_retention')){wp_schedule_event(time()+300,'daily','sdd_business_retention');} }

    private static function operationBatch(string $cutoff):int {
        global $wpdb;$ops=Schema::table('operations');$items=Schema::table('operation_items');$started=false;
        try{
            if($wpdb->query('START TRANSACTION')===false){return 0;}$started=true;
            $ids=$wpdb->get_col($wpdb->prepare("SELECT o.operation_id FROM $ops o WHERE o.status IN ('completed','completed_with_errors') AND o.updated_at<%s AND NOT EXISTS (SELECT 1 FROM $items i WHERE i.operation_id=o.operation_id AND i.status IN ('pending','processing','unknown')) ORDER BY o.updated_at,o.operation_id LIMIT ".self::OPERATION_BATCH.' FOR UPDATE',$cutoff));
            if($wpdb->last_error){throw new \RuntimeException();}
            if(!$ids){$wpdb->query('COMMIT');return 0;}
            $ids=array_values(array_filter(array_map('strval',$ids),static fn($id)=>preg_match('/^[a-f0-9-]{36}$/D',$id)===1));
            if(!$ids){$wpdb->query('COMMIT');return 0;}
            $marks=implode(',',array_fill(0,count($ids),'%s'));
            if($wpdb->query($wpdb->prepare("DELETE FROM $items WHERE operation_id IN ($marks)",...$ids))===false||$wpdb->query($wpdb->prepare("DELETE FROM $ops WHERE operation_id IN ($marks) AND status IN ('completed','completed_with_errors')",...$ids))===false){throw new \RuntimeException();}
            if($wpdb->query('COMMIT')===false){throw new \RuntimeException();}$started=false;return count($ids);
        }catch(\Throwable){if($started){$wpdb->query('ROLLBACK');}API::log('schema_failure');return 0;}
    }

    private static function eventBatch(string $cutoff):int {
        global $wpdb;$events=Schema::table('events');$published=Schema::table('publications');$items=Schema::table('operation_items');$external=Schema::table('external_observations');$ops=Schema::table('operations');$started=false;
        try{
            if($wpdb->query('START TRANSACTION')===false){return 0;}$started=true;
            $ids=$wpdb->get_col($wpdb->prepare("SELECT e.id FROM $events e WHERE e.created_at<%s AND (e.operation_id IS NULL OR NOT EXISTS (SELECT 1 FROM $ops o WHERE o.operation_id=e.operation_id)) AND NOT EXISTS (SELECT 1 FROM $events r WHERE r.reverts_event_id=e.id) AND NOT EXISTS (SELECT 1 FROM $ops ro WHERE ro.preview_json IS NOT NULL AND JSON_VALID(ro.preview_json)=1 AND JSON_SEARCH(ro.preview_json,'one',CAST(e.id AS CHAR),NULL,'$.items[*].reverts_event_id') IS NOT NULL) ORDER BY e.id LIMIT ".self::EVENT_BATCH.' FOR UPDATE',$cutoff));
            if($wpdb->last_error){throw new \RuntimeException();}
            if(!$ids){$wpdb->query('COMMIT');return 0;}
            $ids=array_values(array_filter(array_map('intval',$ids),static fn($id)=>$id>0));
            if(!$ids){$wpdb->query('COMMIT');return 0;}
            $marks=implode(',',array_fill(0,count($ids),'%d'));
            foreach([[$published,'event_id'],[$items,'event_id'],[$external,'event_id'],[$events,'id']] as [$table,$column]){$wpdb->query($wpdb->prepare("DELETE FROM $table WHERE $column IN ($marks)",...$ids));if($wpdb->last_error){throw new \RuntimeException();}}
            if($wpdb->query('COMMIT')===false){throw new \RuntimeException();}$started=false;return count($ids);
        }catch(\Throwable){if($started){$wpdb->query('ROLLBACK');}API::log('schema_failure');return 0;}
    }

    /** Keep field_state/revisions; never delete unknown operations or events referenced by retained rollback history. */
    public static function prune():array {
        if(!Schema::ready()){return ['operations'=>0,'events'=>0,'state'=>'schema_unavailable'];}
        $cutoff=gmdate('Y-m-d H:i:s',time()-self::DAYS*DAY_IN_SECONDS);
        return ['operations'=>self::operationBatch($cutoff),'events'=>self::eventBatch($cutoff),'days'=>self::DAYS,'batch_limits'=>['operations'=>self::OPERATION_BATCH,'events'=>self::EVENT_BATCH],'server_time'=>gmdate('c')];
    }
}
