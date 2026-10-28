<?php
// Run with WP-CLI only against a disposable Local site. Fixtures are rolled back.
use SDD\Schema; use SDD\TemporarySales; use SDD\Dashboard;
global $wpdb; $admin=get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);wp_set_current_user((int)$admin[0]);
$ids=$wpdb->get_col("SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish' ORDER BY ID DESC LIMIT 50");$pid=0;foreach($ids as $id){if(SDD\Policy::accessible((int)$id,true)&&wc_get_product((int)$id)){$pid=(int)$id;break;}}if(!$pid)throw new RuntimeException('No editable product');
$wpdb->query('START TRANSACTION');$errors=[];
try {$id=wp_generate_uuid4();$now=time();$row=['id'=>$id,'product_id'=>$pid,'actor_id'=>(int)$admin[0],'payload_hash'=>str_repeat('a',64),'status'=>'pending','starts_at'=>$now-7200,'ends_at'=>$now-3600,'sale_price'=>'12345','original_json'=>'{}','expected_json'=>'{}','start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'','created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')];if($wpdb->insert(Schema::table('temporary_sales'),$row)===false)throw new RuntimeException($wpdb->last_error);
TemporarySales::tick($id);$state=$wpdb->get_var($wpdb->prepare('SELECT status FROM '.Schema::table('temporary_sales').' WHERE id=%s',$id));$ok=$state==='needs_review'&&Dashboard::alerts([])['state']==='attention';echo ($ok?'PASS':'FAIL')." missed promotion needs review and raises alert\n";if(!$ok)$errors[]='alert';
$result=TemporarySales::cancel($pid,$id,['confirmed'=>true]);$state=$wpdb->get_var($wpdb->prepare('SELECT status FROM '.Schema::table('temporary_sales').' WHERE id=%s',$id));$ok=!is_wp_error($result)&&$state==='cancelled';echo ($ok?'PASS':'FAIL')." review can be closed without starting promotion\n";if(!$ok)$errors[]='close';
} finally {$wpdb->query('ROLLBACK');echo "Fixtures rolled back\n";}if($errors)exit(1);
