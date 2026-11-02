<?php
// WP-CLI against a disposable Local site. Only fixture rows are inserted, then rolled back.
use SDD\Policy;
use SDD\Schema;
use SDD\TemporarySales;
global $wpdb;
$admin=get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);
wp_set_current_user((int)$admin[0]);
$ids=$wpdb->get_col("SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish' ORDER BY ID DESC LIMIT 50");
$pid=0;
foreach($ids as $id){$p=wc_get_product((int)$id);if($p&&$p->is_type('simple')&&Policy::accessible((int)$id,true)){$pid=(int)$id;break;}}
if(!$pid||!Schema::ready())throw new RuntimeException('Local product/schema unavailable');
$failures=[];
$check=static function(bool $ok,string $label)use(&$failures):void{echo ($ok?'PASS ':'FAIL ').$label."\n";if(!$ok)$failures[]=$label;};
$wpdb->query('START TRANSACTION');
try{
 $now=time();$uuid=wp_generate_uuid4();$original=['regular_price'=>'10000','sale_price'=>'9000','sale_dates'=>'|'];
 $row=['id'=>$uuid,'product_id'=>$pid,'actor_id'=>(int)$admin[0],'payload_hash'=>str_repeat('a',64),'status'=>'restored','starts_at'=>$now-7200,'ends_at'=>$now-3600,'sale_price'=>'8500','original_json'=>wp_json_encode($original),'expected_json'=>wp_json_encode($original),'start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'Return status fixture','created_at'=>gmdate('Y-m-d H:i:s',$now+1),'updated_at'=>gmdate('Y-m-d H:i:s',$now)];
 if($wpdb->insert(Schema::table('temporary_sales'),$row)===false)throw new RuntimeException($wpdb->last_error);
 $r=TemporarySales::listing($pid);
 $match=!is_wp_error($r)?array_values(array_filter($r['items'],static fn($i)=>$i['id']===$uuid)):[];
 $check(count($match)===1&&$match[0]['status']==='restored'&&$match[0]['original']===$original,'listing preserves completed return status and immutable original price');
 $check(isset($r['current_price'])&&$r['current_price']===wc_get_product($pid)->get_price('edit'),'current price comes from the product, not the planned return amount');
 $check(is_bool($r['automation']['blocked'])&&$r['automation']['blocked']===(bool)Policy::globalReasons(),'automation pause is reported from actual write conditions');
 $check(!empty($match[0]['updated_at'])&&str_ends_with($match[0]['updated_at'],'Z'),'completed return has an actual update timestamp');
 wp_set_current_user(0);$denied=TemporarySales::listing($pid);$check(is_wp_error($denied)&&$denied->get_error_code()==='forbidden','return status requires product management permission');
}finally{$wpdb->query('ROLLBACK');echo "Fixtures rolled back\n";}
if($failures)exit(1);
