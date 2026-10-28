<?php
// Run with WP-CLI only against a disposable Local site. Fixtures are rolled back.
use SDD\Dashboard; use SDD\Schema;
global $wpdb;
$errors=[];$check=static function($ok,$label)use(&$errors){echo ($ok?'PASS ':'FAIL ').$label."\n";if(!$ok)$errors[]=$label;};
$admin=get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);wp_set_current_user((int)$admin[0]);
$ids=$wpdb->get_col("SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish' ORDER BY ID DESC LIMIT 30");$pid=0;foreach($ids as $id){if(SDD\Policy::accessible((int)$id)&&wc_get_product((int)$id)){$pid=(int)$id;break;}}
if(!$pid||!Schema::ready())throw new RuntimeException('Product or schema unavailable');
$wpdb->query('START TRANSACTION');
try{
 $now=time();$uuid=wp_generate_uuid4();$row=['id'=>$uuid,'product_id'=>$pid,'actor_id'=>(int)$admin[0],'payload_hash'=>str_repeat('a',64),'status'=>'needs_review','starts_at'=>$now-600,'ends_at'=>$now+3600,'sale_price'=>'12345','original_json'=>'{}','expected_json'=>'{}','start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'test review','created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')];
 if($wpdb->insert(Schema::table('temporary_sales'),$row)===false)throw new RuntimeException($wpdb->last_error);
 $month=wp_date('Y-m',$now,wp_timezone());$result=Dashboard::calendar(['month'=>$month]);$alert=Dashboard::alerts([]);
 $check(!is_wp_error($result)&&count(array_filter($result['items'],fn($i)=>$i['promotion_id']===$uuid&&$i['status']==='needs_review'&&$i['price']==='12345'))===1,'calendar shows accessible review promotion with price');
 $check(!is_wp_error($alert)&&$alert['state']==='attention','review promotion raises alert');
 $wrong=Dashboard::calendar(['month'=>'2026-13']);$check(is_wp_error($wrong)&&$wrong->get_error_code()==='invalid_query','invalid month rejected');
 wp_set_current_user(0);$a=Dashboard::alerts([]);$c=Dashboard::calendar(['month'=>$month]);$check(is_wp_error($a)&&$a->get_error_code()==='forbidden'&&is_wp_error($c)&&$c->get_error_code()==='forbidden','calendar and alerts require permission');
}finally{$wpdb->query('ROLLBACK');echo "Fixtures rolled back\n";}
if($errors)exit(1);
