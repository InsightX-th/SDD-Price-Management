<?php
declare(strict_types=1);
namespace SDD;
/** Read-only product snapshots plus best-effort, per-tab editing hints. */
final class WorkspaceSync {
    private const TTL = 45;
    private static function key(int $id): string { return 'sdd_presence_'.$id; }
    private static function entries(int $id): array {
        $stored=get_transient(self::key($id));
        return is_array($stored)?array_filter($stored,static fn($entry)=>is_array($entry)&&($entry['expires_at']??0)>time()):[];
    }
    private static function remove(int $id,string $token): void {
        $entries=self::entries($id);unset($entries[$token]);
        if($entries){set_transient(self::key($id),$entries,self::TTL);}else{delete_transient(self::key($id));}
    }
    public static function read(mixed $in): array|\WP_Error {
        if(!current_user_can('sdd_view_products')){return API::error('forbidden','ไม่มีสิทธิ์ดูสินค้า',403);}
        if(!is_array($in)||array_diff(array_keys($in),['ids','client_id','active'])||!is_array($in['ids']??null)||!array_is_list($in['ids'])||count($in['ids'])>100||!is_string($in['client_id']??null)||!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D',$in['client_id'])){
            return API::error('invalid_input','รูปแบบข้อมูลอัปเดตไม่ถูกต้อง',400);
        }
        $ids=[];
        foreach($in['ids'] as $id){
            if(!is_string($id)||!preg_match('/^[1-9][0-9]{0,17}$/D',$id)){return API::error('invalid_input','รหัสสินค้าไม่ถูกต้อง',400);}
            $ids[]=(int)$id;
        }
        $ids=array_values(array_unique($ids));$uid=get_current_user_id();
        $token=hash('sha256',$uid.':'.$in['client_id']);$focusKey='sdd_focus_'.$token;
        if(array_key_exists('active',$in)){
            $active=$in['active'];$pid=0;
            if($active!==null){
                if(!is_array($active)||array_diff(array_keys($active),['product_id','field'])||!is_string($active['product_id']??null)||!preg_match('/^[1-9][0-9]{0,17}$/D',$active['product_id'])||!in_array($active['field']??null,['regular_price','sale_price','stock_status','temporary_sale'],true)){
                    return API::error('invalid_input','ช่องที่กำลังแก้ไม่ถูกต้อง',400);
                }
                $pid=(int)$active['product_id'];
                if(!current_user_can('sdd_edit_products')||!Policy::accessible($pid,true)||($active['field']==='temporary_sale'&&!current_user_can('sdd_manage_settings'))){return API::error('not_found','ไม่พบสินค้าที่แก้ไขได้',404);}
            }
            $previous=(int)get_transient($focusKey);
            if($previous&&$previous!==$pid){self::remove($previous,$token);}
            if($pid){
                $entries=self::entries($pid);
                // Presence is advisory. Races/cache eviction may drop hints, never a lock.
                $entries[$token]=['user_id'=>$uid,'actor'=>wp_strip_all_tags(wp_get_current_user()->display_name),'field'=>$active['field'],'expires_at'=>time()+self::TTL];
                $entries=array_slice($entries,-30,null,true);
                set_transient(self::key($pid),$entries,self::TTL);set_transient($focusKey,$pid,self::TTL);
            }else{delete_transient($focusKey);}
        }
        $visible=array_values(array_filter($ids,static fn($id)=>Policy::accessible($id)));
        // Durable publication is independent of product writes and snapshot availability.
        // A failed publisher retries on a later heartbeat/cron; it never rejects this read.
        if ($visible) { ExternalChanges::drain($visible);Feed::publish(); }
        $presence=[];
        foreach($visible as $id){
            $others=[];
            foreach(self::entries($id) as $tab=>$entry){
                if($tab===$token){continue;}
                $others[]=['actor'=>$entry['actor'],'field'=>$entry['field'],'own_user'=>(int)$entry['user_id']===$uid];
            }
            if($others){$presence[(string)$id]=$others;}
        }
        return ['items'=>Catalog::snapshots($visible),'unavailable'=>array_map('strval',array_values(array_diff($ids,$visible))),'presence'=>(object)$presence,'server_time'=>gmdate('Y-m-d\TH:i:s\Z'),'interval_seconds'=>15];
    }
}
