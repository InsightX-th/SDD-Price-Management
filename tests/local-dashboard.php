<?php
// Run with WP-CLI only against a disposable Local site. Fixtures are rolled back.
use SDD\Dashboard;
use SDD\Schema;
global $wpdb;
$errors=[];
$check=static function(bool $ok,string $message) use (&$errors):void { echo ($ok?'PASS ':'FAIL ').$message."\n"; if (!$ok) $errors[]=$message; };
$admin=get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);
if (!$admin) { fwrite(STDERR,"No administrator found\n"); exit(1); }
wp_set_current_user((int)$admin[0]);
$ids=$wpdb->get_col("SELECT ID FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish' ORDER BY ID DESC LIMIT 30");
$id=0; foreach ($ids as $candidate) { if (SDD\Policy::accessible((int)$candidate) && wc_get_product((int)$candidate)) { $id=(int)$candidate; break; } }
if (!$id || !Schema::ready()) { fwrite(STDERR,"No accessible product or schema unavailable\n"); exit(1); }
if ($wpdb->query('START TRANSACTION')===false) { fwrite(STDERR,"Cannot begin transaction\n"); exit(1); }
try {
 $now=time(); $marker='dashboard-check-'.wp_generate_uuid4();
 $sale=['id'=>wp_generate_uuid4(),'product_id'=>$id,'actor_id'=>(int)$admin[0],'payload_hash'=>str_repeat('a',64),'status'=>'needs_review','starts_at'=>$now-7200,'ends_at'=>$now-3600,'sale_price'=>'900','original_json'=>'{}','expected_json'=>'{}','start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>$marker,'created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')];
 if ($wpdb->insert(Schema::table('temporary_sales'),$sale)===false) throw new RuntimeException('Cannot insert review fixture: '.$wpdb->last_error);
 $sale['id']=wp_generate_uuid4();$sale['status']='pending';$sale['starts_at']=$now+2*DAY_IN_SECONDS;$sale['ends_at']=$now+3*DAY_IN_SECONDS;$sale['start_operation']=wp_generate_uuid4();$sale['end_operation']=wp_generate_uuid4();$sale['message']='';
 if ($wpdb->insert(Schema::table('temporary_sales'),$sale)===false) throw new RuntimeException('Cannot insert scheduled fixture: '.$wpdb->last_error);
 $event=['product_id'=>$id,'field'=>'regular_price','old_value'=>'98765432100','new_value'=>'69135802470','revision_before'=>0,'revision_after'=>1,'source'=>'dashboard_test','request_id'=>wp_generate_uuid4(),'created_at'=>gmdate('Y-m-d H:i:s')];
 if ($wpdb->insert(Schema::table('events'),$event)===false) throw new RuntimeException('Cannot insert price fixture: '.$wpdb->last_error);
 $day=Dashboard::read(['hours'=>'24','threshold'=>'30']);$week=Dashboard::read(['hours'=>'168','threshold'=>'30']);$high=Dashboard::read(['hours'=>'168','threshold'=>'50']);
 if (is_wp_error($day)||is_wp_error($week)||is_wp_error($high)) throw new RuntimeException('Dashboard returned an error');
 $has=static fn(array $rows,callable $predicate):bool => count(array_filter($rows,$predicate))>0;
 $check($has($day['problems']['items'],static fn($r)=>$r['message']===$marker),'review promotion appears');
 $start=$now+2*DAY_IN_SECONDS; $finish=$now+3*DAY_IN_SECONDS;
 $fixture=static fn($r)=>$r['id']===(string)$id && in_array($r['at'],[$start,$finish],true);
 $check(!$has($day['upcoming']['items'],$fixture),'two-day promotion excluded from 24-hour filter');
 $check(count(array_filter($week['upcoming']['items'],$fixture))===2,'seven-day filter includes both start and end');
 $price=static fn($r)=>$r['old_value']==='98765432100' && $r['new_value']==='69135802470';
 $check($has($week['changes']['items'],$price),'30 percent threshold includes boundary');
 $check(!$has($high['changes']['items'],$price),'50 percent threshold excludes 30 percent decrease');
 $check(!isset($week['stock']),'removed stock category is absent');
 $invalid=Dashboard::read(['hours'=>'25']);$check(is_wp_error($invalid)&&$invalid->get_error_code()==='invalid_query','invalid filters rejected');
 wp_set_current_user(0);$forbidden=Dashboard::read([]);$check(is_wp_error($forbidden)&&$forbidden->get_error_code()==='forbidden','unauthorized user rejected');
} catch (Throwable $e) { $errors[]=$e->getMessage(); fwrite(STDERR,$e->getMessage()."\n"); }
finally { $wpdb->query('ROLLBACK'); echo "Fixtures rolled back\n"; }
if ($errors) exit(1);
