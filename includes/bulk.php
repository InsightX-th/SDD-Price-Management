<?php
declare(strict_types=1);
namespace SDD;
/** Durable previews orchestrate the shared writer; never perform product writes here. */
final class Bulk {
    private static function uuid(mixed $id): bool { return is_string($id) && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D',$id)===1; }
    private static function access(string $kind): true|\WP_Error {
        if (!current_user_can('sdd_view_products') || !current_user_can('sdd_edit_products') || !current_user_can($kind==='rollback'?'sdd_rollback':'sdd_bulk_edit')) { return API::error('forbidden','ไม่มีสิทธิ์ดำเนินการชุดนี้',403); }
        if (!Schema::ready()) { return API::error('schema_unavailable','Schema ไม่พร้อม',503); }
        if ($reasons=Policy::globalReasons()) { return API::error('write_unavailable',implode('; ',$reasons),503); }
        return true;
    }
    public static function rate(): true|\WP_Error {
        $key='sdd_bulk_rate_'.get_current_user_id().'_'.gmdate('YmdHi');$n=(int)get_transient($key);
        if ($n>=10) { return API::error('rate_limited','คำสั่งหลายรายการครบ 10 ครั้งต่อนาที กรุณารอก่อนดำเนินการต่อ',429,['retry_after'=>60]); }
        set_transient($key,$n+1,120);return true;
    }
    private static function check(\WC_Product $p,string $field): true|\WP_Error {
        global $wpdb;
        if (!Policy::accessible($p->get_id(),true)) { return API::error('forbidden','ไม่มีสิทธิ์แก้สินค้านี้',403); }
        if ($reasons=Policy::fieldReasons($p,$field)) { return API::error('write_unavailable',implode('; ',$reasons),503); }
        if (Policy::values($p)['sale_dates']!=='|') { return API::error('scheduled_price','มีวันโปรเดิม: ใช้การแก้ทีละสินค้าหรือจัดการโปร',409); }
        if ($wpdb->get_var($wpdb->prepare('SELECT id FROM '.Schema::table('temporary_sales')." WHERE product_id=%d AND status IN ('pending','active','needs_review') LIMIT 1",$p->get_id()))) { return API::error('temporary_plan','มีโปรชั่วคราวที่ยังไม่ปิด: จัดการโปรก่อน',409); }
        return true;
    }
    /** Exact arithmetic on bounded integer inputs. No float or repeated discount. */
    public static function calculate(string $base,array $params): string|\WP_Error {
        if (!Policy::integer($base)) { return API::error('missing_basis','ไม่มีราคาฐานที่รองรับ',400); }
        $b=(int)$base;$amount=$params['amount'];$increase=$params['direction']==='increase';
        if ($params['unit']==='percent') {
            [$whole,$fraction]=array_pad(explode('.',$amount),2,'');$pct=(int)$whole*100+(int)str_pad($fraction,2,'0');
            $factor=10000+($increase?$pct:-$pct);
            $value=intdiv($b,10000)*$factor+intdiv(($b%10000)*$factor+5000,10000);
        } else { $value=$increase?$b+(int)$amount:$b-(int)$amount; }
        if ($value<0 || $value>999999999999999) { return API::error('price_range','ผลราคาติดลบหรือเกิน 15 หลัก ไม่ปรับเป็นศูนย์อัตโนมัติ',400); }
        return (string)$value;
    }
    private static function parameters(mixed $p): array|\WP_Error {
        if (!is_array($p) || count($p)!==5 || array_diff(array_keys($p),['target','basis','direction','unit','amount']) || count(array_filter($p,'is_string'))!==5 || !in_array([$p['target'],$p['basis']],[['regular_price','regular_price'],['sale_price','sale_price'],['sale_price','regular_price']],true) || !in_array($p['direction'],['increase','decrease'],true) || !in_array($p['unit'],['baht','percent'],true)) { return API::error('invalid_input','รูปแบบสูตรราคาไม่ถูกต้อง',400); }
        if ($p['unit']==='baht' ? !Policy::integer($p['amount']) : (!preg_match('/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/D',$p['amount']) || (int)explode('.',$p['amount'])[0]>100 || ((int)explode('.',$p['amount'])[0]===100 && (int)(explode('.',$p['amount'])[1]??'0')!==0))) { return API::error('invalid_input','บาทต้องเป็นจำนวนเต็ม เปอร์เซ็นต์ต้องอยู่ระหว่าง 0–100 และทศนิยมไม่เกิน 2 ตำแหน่ง',400); }
        return array_intersect_key(array_replace(['target'=>'','basis'=>'','direction'=>'','unit'=>'','amount'=>''],$p),$p);
    }
    public static function preview(mixed $in): array|\WP_Error {
        if (is_wp_error($a=self::access('bulk'))) { return $a; }
        if (!is_array($in) || count($in)!==3 || array_diff(array_keys($in),['ids','action','params']) || ($in['action']??'')!=='adjust_price' || !is_array($in['ids']??null) || !array_is_list($in['ids']) || count($in['ids'])<1 || count($in['ids'])>200) { return API::error('invalid_input','เลือกรายการ 1–200 รายการและระบุสูตรราคา',400); }
        $params=self::parameters($in['params']??null);if (is_wp_error($params)) { return $params; }
        $ids=[];foreach($in['ids'] as $id) { if (!is_string($id)||!preg_match('/^[1-9][0-9]{0,14}$/D',$id)) { return API::error('invalid_input','รหัสสินค้าไม่ถูกต้อง',400); } $ids[]=$id; }
        $ids=array_values(array_unique($ids));sort($ids,SORT_NUMERIC);$rows=[];
        foreach($ids as $id) {
            // Refuse the entire request on inaccessible IDs: no hidden product metadata in previews.
            if (!Policy::accessible((int)$id,true)) { return API::error('forbidden','มีสินค้าที่ไม่มีสิทธิ์แก้',403); }
            $p=Writer::fresh((int)$id);if (!$p) { return API::error('not_found','ไม่พบสินค้า',404); }
            $values=Policy::values($p);$target=self::calculate($values[$params['basis']],$params);
            $valid=self::check($p,$params['target']);
            if (!is_wp_error($valid) && $params['basis']==='sale_price' && in_array($values['sale_price'],['','0'],true)) { $valid=API::error('missing_sale','ไม่มีราคาโปรเดิมให้ปรับ',400); }
            if (!is_wp_error($valid) && is_wp_error($target)) { $valid=$target; }
            if (!is_wp_error($valid)) { $valid=Policy::validate($p,$params['target'],$target,['price_change','zero_price','expired_schedule']); }
            $rows[]=self::item($p,$params['target'],is_wp_error($target)?$values[$params['target']]:$target,$valid,$values[$params['basis']]);
        }
        return self::store('bulk',['action'=>'adjust_price','params'=>$params,'ids'=>$ids],$rows);
    }
    private static function item(\WC_Product $p,string $field,string $target,true|\WP_Error $valid,string $basis): array {
        $values=Policy::values($p);$revisions=[];foreach(Policy::FIELDS as $f) { $revisions[$f]=Writer::revision($p->get_id(),$f); }
        return ['item_id'=>wp_generate_uuid4(),'child_operation'=>wp_generate_uuid4(),'product_id'=>(string)$p->get_id(),'name'=>$p->get_name(),'field'=>$field,'before'=>$values[$field],'basis'=>$basis,'after'=>$target,'snapshot'=>$values,'revisions'=>$revisions,'status'=>is_wp_error($valid)?'skipped':($target===$values[$field]?'skipped':'pending'),'reason'=>is_wp_error($valid)?$valid->get_error_message():($target===$values[$field]?'ราคาไม่เปลี่ยน':''),'warning'=>!is_wp_error($valid)&&$target==='0'?'ราคาจะเป็นศูนย์':'','reverts_event_id'=>null];
    }
    private static function store(string $kind,array $params,array $rows): array|\WP_Error {
        global $wpdb;$op=wp_generate_uuid4();$actor=get_current_user_id();$expires=gmdate('Y-m-d H:i:s',time()+600);$now=gmdate('Y-m-d H:i:s');
        $preview=['actor'=>$actor,'kind'=>$kind,'params'=>$params,'items'=>$rows,'expires_at'=>$expires];$hash=hash('sha256',wp_json_encode($preview));
        $errors=$wpdb->suppress_errors(true);
        try {
            if ($wpdb->query('START TRANSACTION')===false || $wpdb->insert(Schema::table('operations'),['operation_id'=>$op,'actor_id'=>$actor,'kind'=>$kind,'payload_hash'=>$hash,'preview_json'=>wp_json_encode($preview),'status'=>'preview','expires_at'=>$expires,'created_at'=>$now,'updated_at'=>$now])===false) { throw new \RuntimeException(); }
            foreach($rows as $r) { if ($wpdb->insert(Schema::table('operation_items'),['item_id'=>$r['item_id'],'operation_id'=>$op,'product_id'=>$r['product_id'],'field'=>$r['field'],'base_value'=>$r['before'],'base_revision'=>$r['revisions'][$r['field']],'target_value'=>$r['after'],'status'=>$r['status'],'created_at'=>$now,'updated_at'=>$now])===false) { throw new \RuntimeException(); } }
            if ($wpdb->query('COMMIT')===false) { throw new \RuntimeException(); }
        } catch (\Throwable $e) { $wpdb->query('ROLLBACK');return API::error('preview_unavailable','บันทึกตัวอย่างไม่สำเร็จ ราคาสินค้ายังไม่เปลี่ยน',503); }
        finally { $wpdb->suppress_errors($errors); }
        return self::status($op);
    }
    private static function owned(string $id): array|\WP_Error {
        global $wpdb;
        if (!self::uuid($id) || !Schema::ready() || !current_user_can('sdd_view_products')) { return API::error('not_found','ไม่พบชุดคำสั่งที่มีสิทธิ์ดู',404); }
        $op=$wpdb->get_row($wpdb->prepare('SELECT * FROM '.Schema::table('operations').' WHERE operation_id=%s',$id),ARRAY_A);
        if (!$op || (int)$op['actor_id']!==get_current_user_id() || !in_array($op['kind'],['bulk','rollback'],true)) { return API::error('not_found','ไม่พบชุดคำสั่งที่มีสิทธิ์ดู',404); }
        $preview=json_decode($op['preview_json'],true);
        if (!is_array($preview) || !hash_equals($op['payload_hash'],hash('sha256',wp_json_encode($preview)))) { return API::error('preview_corrupt','ข้อมูลตัวอย่างไม่ครบ หยุดดำเนินการ',409); }
        foreach($preview['items'] as $r) { if (!Policy::accessible((int)$r['product_id'])) { return API::error('not_found','ไม่มีสิทธิ์ดูรายการในชุดนี้แล้ว',404); } }
        return $op;
    }
    public static function isBatch(string $id): bool { global $wpdb;return in_array($wpdb->get_var($wpdb->prepare('SELECT kind FROM '.Schema::table('operations').' WHERE operation_id=%s',$id)),['bulk','rollback'],true); }
    private static function resolved(array $row,array $meta): array {
        global $wpdb;$result=$row['canonical_result_json']?json_decode($row['canonical_result_json'],true):null;$status=$row['status'];
        if (in_array($status,['processing','unknown'],true)) {
            $child=$wpdb->get_row($wpdb->prepare('SELECT i.canonical_result_json FROM '.Schema::table('operation_items').' i JOIN '.Schema::table('operations').' o ON o.operation_id=i.operation_id WHERE o.operation_id=%s AND o.actor_id=%d AND i.product_id=%d',$meta['child_operation'],get_current_user_id(),$row['product_id']),ARRAY_A);
            $result=$child&&$child['canonical_result_json']?json_decode($child['canonical_result_json'],true):null;
            $status=$result?(isset($result['code'])?($result['code']==='field_conflict'?'conflict':'failed'):'succeeded'):'unknown';
        }
        return ['status'=>$status,'result'=>$result];
    }
    public static function status(string $id): array|\WP_Error {
        global $wpdb;$op=self::owned($id);if (is_wp_error($op)) { return $op; }$preview=json_decode($op['preview_json'],true);$items=[];$counts=[];
        foreach($preview['items'] as $meta) {
            $r=$wpdb->get_row($wpdb->prepare('SELECT * FROM '.Schema::table('operation_items').' WHERE item_id=%s AND operation_id=%s',$meta['item_id'],$id),ARRAY_A);if (!$r) { return API::error('preview_corrupt','รายการตัวอย่างไม่ครบ',409); }
            $resolved=self::resolved($r,$meta);$counts[$resolved['status']]=($counts[$resolved['status']]??0)+1;
            $items[]=array_diff_key($meta,array_flip(['snapshot','revisions','child_operation','reverts_event_id']))+$resolved;
            // Stored status takes precedence over immutable preview status.
            $items[count($items)-1]['status']=$resolved['status'];
        }
        $pending=$counts['pending']??0;$unknown=$counts['unknown']??0;$expired=strtotime($op['expires_at'].' UTC')<=time();
        $status=$unknown?'needs_reconciliation':($pending?($expired?'expired':($op['status']==='preview'?'preview':'running')):(($counts['failed']??0)+($counts['conflict']??0)>0?'completed_with_errors':'completed'));
        return ['operation_id'=>$id,'kind'=>$op['kind'],'payload_hash'=>$op['payload_hash'],'expires_at'=>str_replace(' ','T',$op['expires_at']).'Z','status'=>$status,'progress'=>$counts,'pending'=>$pending,'unknown'=>$unknown,'items'=>$items,'params'=>$preview['params']];
    }
    public static function execute(string $id,mixed $in): array|\WP_Error {
        global $wpdb;$op=self::owned($id);if (is_wp_error($op)) { return $op; }
        if (is_wp_error($a=self::access($op['kind']))) { return $a; }
        if (!is_array($in) || count($in)!==2 || array_diff(array_keys($in),['confirmation_hash','acknowledgements']) || !is_string($in['confirmation_hash']??null) || !hash_equals($op['payload_hash'],$in['confirmation_hash']) || !is_array($in['acknowledgements']??null) || !array_is_list($in['acknowledgements']) || count($in['acknowledgements'])>2 || count(array_filter($in['acknowledgements'],'is_string'))!==count($in['acknowledgements']) || array_diff($in['acknowledgements'],['price_change','zero_price']) || !in_array('price_change',$in['acknowledgements'],true)) { return API::error('confirmation_required','ยืนยันตัวอย่างเดิมให้ครบ ห้ามเปลี่ยนราคาหลังดูตัวอย่าง',400); }
        $preview=json_decode($op['preview_json'],true);
        foreach($preview['items'] as $r) { if ($r['status']==='pending'&&$r['after']==='0'&&!in_array('zero_price',$in['acknowledgements'],true)) { return API::error('confirmation_required','ต้องยืนยันราคา 0 โดยเฉพาะ',400); } }
        $lock='sdd:'.substr(hash('sha256',DB_NAME.':'.$wpdb->prefix.':bulk:'.$id),0,58);
        if ((string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,3)',$lock))!=='1') { return API::error('lock_timeout','ชุดนี้กำลังทำงาน ตรวจผลก่อนดำเนินการต่อ',503); }
        $errors=$wpdb->suppress_errors(true);
        try {
            $observed=self::status($id);if (is_wp_error($observed)) { return $observed; } if ($observed['unknown']>0) { return $observed; }
            $started=microtime(true);$processed=0;
            foreach($preview['items'] as $meta) {
                $item=$wpdb->get_row($wpdb->prepare('SELECT * FROM '.Schema::table('operation_items').' WHERE item_id=%s',$meta['item_id']),ARRAY_A);
                if (!$item) { throw new \RuntimeException(); }
                if ($item['status']!=='pending') { continue; }
                if (is_wp_error($a=self::access($op['kind']))) { return $a; }
                if (strtotime($op['expires_at'].' UTC')<=time()) { return API::error('preview_expired','ตัวอย่างหมดอายุ ต้องสร้างตัวอย่างใหม่สำหรับรายการค้าง',410); }
                if ($processed>=20 || ($processed>0 && microtime(true)-$started>=5)) { break; }
                if ($wpdb->update(Schema::table('operation_items'),['status'=>'processing','updated_at'=>gmdate('Y-m-d H:i:s')],['item_id'=>$meta['item_id'],'status'=>'pending'])!==1) { throw new \RuntimeException(); }
                $pid=(int)$meta['product_id'];$field=$meta['field'];$kind=$op['kind'];
                $guard=static function()use($kind,$pid,$field,$meta):true|\WP_Error {
                    if (is_wp_error($a=self::access($kind))) { return $a; }$p=Writer::fresh($pid);
                    if (!$p) { return API::error('not_found','ไม่พบสินค้า',404); } if (is_wp_error($check=self::check($p,$field))) { return $check; }
                    if ($kind==='rollback') { global $wpdb;$e=$wpdb->get_row($wpdb->prepare('SELECT new_value,revision_after FROM '.Schema::table('events').' WHERE id=%d',(int)$meta['reverts_event_id']),ARRAY_A);return $e&&$e['new_value']===$meta['before']&&(string)$e['revision_after']===$meta['revisions'][$field]?true:API::error('field_conflict','เหตุการณ์เปลี่ยน ต้องตรวจสอบ',409); }
                    return true;
                };
                $result=Writer::transition($pid,['operation_id'=>$meta['child_operation'],'field'=>$field,'value'=>$meta['after'],'base_value'=>$meta['before'],'base_revision'=>$meta['revisions'][$field],'acknowledgements'=>$in['acknowledgements']],['expected'=>$meta['snapshot'],'revisions'=>$meta['revisions'],'target'=>[$field=>$meta['after'],'sale_dates'=>$meta['snapshot']['sale_dates']],'promotion'=>'bulk:'.$id,'source'=>$kind==='rollback'?'rollback':'bulk_action','kind'=>'bulk_item','reverts_event_id'=>$meta['reverts_event_id'],'guard'=>$guard,'record'=>static function(array $values):void{}]);
                $encoded=is_wp_error($result)?['code'=>$result->get_error_code(),'message'=>$result->get_error_message(),'data'=>$result->get_error_data()]:$result;
                $state=is_wp_error($result)?($result->get_error_code()==='operation_unknown'||$result->get_error_code()==='lock_timeout'?'unknown':($result->get_error_code()==='field_conflict'?'conflict':'failed')):'succeeded';
                if ($wpdb->update(Schema::table('operation_items'),['status'=>$state,'canonical_result_json'=>wp_json_encode($encoded),'error_code'=>is_wp_error($result)?$result->get_error_code():null,'event_id'=>is_wp_error($result)?null:($result['event_id']??null),'updated_at'=>gmdate('Y-m-d H:i:s')],['item_id'=>$meta['item_id']])===false) { throw new \RuntimeException(); }
                $processed++;if ($state==='unknown') { break; }
            }
            $status=self::status($id);if (is_wp_error($status)) { return $status; }
            if ($wpdb->update(Schema::table('operations'),['status'=>$status['status'],'updated_at'=>gmdate('Y-m-d H:i:s')],['operation_id'=>$id])===false) { throw new \RuntimeException(); }
            return $status;
        } catch(\Throwable $e) { API::log('writer_failure');return API::error('operation_unknown','ตรวจผลชุดคำสั่งก่อนดำเนินการต่อ',409,['operation_id'=>$id]); }
        finally { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)',$lock));$wpdb->suppress_errors($errors); }
    }
    public static function rollbackPreview(string $eventId,mixed $in): array|\WP_Error {
        global $wpdb;if (is_wp_error($a=self::access('rollback'))) { return $a; }
        if (!is_array($in) || $in!==[] || !preg_match('/^[1-9][0-9]{0,17}$/D',$eventId)) { return API::error('invalid_input','ระบุเฉพาะรหัสเหตุการณ์ที่จะย้อน',400); }
        $event=$wpdb->get_row($wpdb->prepare('SELECT * FROM '.Schema::table('events').' WHERE id=%d',(int)$eventId),ARRAY_A);
        if (!$event || !Policy::accessible((int)$event['product_id'],true)) { return API::error('not_found','ไม่พบเหตุการณ์ที่มีสิทธิ์ย้อน',404); }
        if (!in_array($event['field'],['regular_price','sale_price'],true)) { return API::error('unsupported_event','รุ่นนี้ย้อนคืนเฉพาะเหตุการณ์ราคา',400); }
        $p=Writer::fresh((int)$event['product_id']);$field=$event['field'];
        if (!$p || Policy::values($p)[$field]!==$event['new_value'] || Writer::revision($p->get_id(),$field)!==(string)$event['revision_after']) { return API::error('field_conflict','ราคาหรือ revision เปลี่ยนหลังเหตุการณ์นี้แล้ว ย้อนทับไม่ได้',409); }
        if (is_wp_error($valid=self::check($p,$field))) { return $valid; }
        if (is_wp_error($valid=Policy::validate($p,$field,$event['old_value'],['price_change','zero_price']))) { return $valid; }
        $item=self::item($p,$field,$event['old_value'],true,$event['new_value']);$item['reverts_event_id']=$eventId;
        return self::store('rollback',['event_id'=>$eventId],[$item]);
    }
}
