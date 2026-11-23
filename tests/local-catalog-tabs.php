<?php
/** Run via WP-CLI against disposable Local WordPress only; fixtures are removed. */
use SDD\{Catalog,Schema};
if(!str_contains(ABSPATH,'Local Sites')){throw new RuntimeException('Local only');}
global $wpdb;
$admin=(int)get_users(['role'=>'administrator','number'=>1,'fields'=>'ID'])[0];wp_set_current_user($admin);
$ids=[];$plans=[];$viewer=0;$prefix='sdd-tabs-'.wp_generate_password(10,false).'-';$now=time();
$check=static function($ok,$label){if(!$ok){throw new RuntimeException($label);}echo "PASS $label\n";};
$make=static function($name,$from=0,$to=0,$sale='80',$parent=0)use(&$ids,$prefix,$admin){
 $p=$parent?new WC_Product_Variation():new WC_Product_Simple();if($parent){$p->set_parent_id($parent);}
 $p->set_name($prefix.$name);$p->set_status('publish');$p->set_regular_price('100');$p->set_sale_price($sale);$p->set_date_on_sale_from($from?:null);$p->set_date_on_sale_to($to?:null);$p->set_stock_status('instock');$p->save();$ids[]=$p->get_id();wp_update_post(['ID'=>$p->get_id(),'post_author'=>$admin]);return $p->get_id();
};
$query=static function($scope,$extra=[])use($prefix){$r=Catalog::products(array_merge(['search'=>$prefix,'scope'=>$scope,'per_page'=>100],$extra));if(is_wp_error($r)){throw new RuntimeException($r->get_error_message());}return $r;};
$contains=static fn($r,$id)=>in_array((string)$id,array_column($r['items'],'id'),true);
try{
 $permanent=$make('permanent');$soon=$make('soon',$now-3600,$now+3600);$later=$make('later',$now-3600,$now+172800);$future=$make('future',$now+3600,$now+7200);$expired=$make('expired',$now-7200,$now-3600);$none=$make('none',0,0,'');$invalid=$make('invalid',0,0,'120');$temporary=$make('temporary');$pending=$make('pending',0,0,'');
 foreach([[$temporary,'active',$now-600,$now+7200],[$pending,'pending',$now+7200,$now+10800]] as [$id,$state,$from,$to]){
  $uuid=wp_generate_uuid4();$plans[]=$uuid;
  $ok=$wpdb->insert(Schema::table('temporary_sales'),['id'=>$uuid,'product_id'=>$id,'actor_id'=>$admin,'payload_hash'=>str_repeat('b',64),'status'=>$state,'starts_at'=>$from,'ends_at'=>$to,'sale_price'=>'80','original_json'=>'{}','expected_json'=>'{}','start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'','created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')]);if(!$ok){throw new RuntimeException($wpdb->last_error);}
 }
 $current=$query('current');$check($contains($current,$temporary)&&$current['total']===1,'current includes only active temporary promotions');
 $check(!$contains($current,$permanent)&&!$contains($current,$soon)&&!$contains($current,$later)&&!$contains($current,$pending)&&!$contains($current,$future)&&!$contains($current,$expired)&&!$contains($current,$none)&&!$contains($current,$invalid),'current excludes permanent, native scheduled, pending and non-promotional products');
 $ending=$query('expiring');$check($contains($ending,$temporary)&&!$contains($ending,$soon)&&!$contains($ending,$permanent)&&!$contains($ending,$later),'expiring includes only active temporary ends within 24 hours');
 $upcoming=$query('upcoming');$check($contains($upcoming,$pending)&&!$contains($upcoming,$future)&&!$contains($upcoming,$temporary),'upcoming includes only pending temporary plans before start');
 $check($current['tab_counts']['current']===$current['total']&&$current['tab_counts']['expiring']===$ending['total']&&$current['tab_counts']['upcoming']===$upcoming['total'],'tab counts agree with displayed result totals');
 $check($current['tab_counts']['all']===9,'all count respects search and counts parents only');
 $check($query('expiring',['stock_status'=>'outofstock'])['total']===0,'stock filter is preserved inside promotion tab');
 $check($query('expiring',['promotion_status'=>'future'])['total']===$ending['total'],'legacy URLs cannot leave a hidden status filter inside a temporary tab');
 $check($query('current',['page'=>2])['items']===[],'pagination preserves promotion scope');
 $record=array_values(array_filter($current['items'],static fn($r)=>$r['id']===(string)$temporary))[0];$check($record['temporary_sale']['ends_at']===$now+7200,'temporary end time is exposed for catalog display');
 $check($record['temporary_sale']['price']==='80'&&array_key_exists('current_price',$record),'catalog exposes current system and temporary target prices');
 $native=$query('all',['promotion_status'=>'future']);$check($contains($native,$future)&&$contains($native,$pending),'all-products filter still includes native WooCommerce schedules');
 $zero=$make('zero',0,0,'0');
 $generalCurrent=$query('all',['promotion_status'=>'current']);
 $check($contains($generalCurrent,$permanent)&&$contains($generalCurrent,$soon)&&$contains($generalCurrent,$temporary)&&$contains($generalCurrent,$zero)&&!$contains($generalCurrent,$none)&&!$contains($generalCurrent,$expired),'general current filter includes native and zero-price promotions without altering temporary tabs');
 $predicate=new ReflectionMethod(Catalog::class,'promotion');
 $sql=$predicate->invoke(null,'p',['promotion'=>'temporary_expiring','now'=>$now]);
 $wpdb->update(Schema::table('temporary_sales'),['ends_at'=>$now+86400],['product_id'=>$temporary]);
 $check((int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->posts} p WHERE p.ID=%d AND $sql",$temporary))===1,'exact 24-hour boundary is included');
 $wpdb->update(Schema::table('temporary_sales'),['ends_at'=>$now+86401],['product_id'=>$temporary]);
 $check((int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM {$wpdb->posts} p WHERE p.ID=%d AND $sql",$temporary))===0,'one second beyond 24 hours is excluded');
 $wpdb->update(Schema::table('temporary_sales'),['ends_at'=>$now+7200,'status'=>'needs_review'],['product_id'=>$temporary]);
 $check(!$contains($query('current'),$temporary)&&!$contains($query('expiring'),$temporary),'review-needed plans do not appear in active or expiring tabs');
 $wpdb->update(Schema::table('temporary_sales'),['status'=>'active'],['product_id'=>$temporary]);
 $parent=new WC_Product_Variable();$parent->set_name($prefix.'variants');$parent->set_status('publish');$parent->save();$ids[]=$parent->get_id();wp_update_post(['ID'=>$parent->get_id(),'post_author'=>$admin]);
 $child=$make('variant-soon',$now-300,$now+3600,'80',$parent->get_id());$make('variant-future',$now+3600,$now+7200,'70',$parent->get_id());
 $uuid=wp_generate_uuid4();$plans[]=$uuid;
 $wpdb->insert(Schema::table('temporary_sales'),['id'=>$uuid,'product_id'=>$child,'actor_id'=>$admin,'payload_hash'=>str_repeat('b',64),'status'=>'active','starts_at'=>$now-600,'ends_at'=>$now+3600,'sale_price'=>'75','original_json'=>'{}','expected_json'=>'{}','start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'','created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')]);
 $withVariable=$query('expiring');$check($contains($withVariable,$parent->get_id())&&$withVariable['total']===$ending['total']+1,'variable parent counts once when an eligible child matches');
 $children=Catalog::variations($parent->get_id(),['scope'=>'expiring','per_page'=>100]);$check(!is_wp_error($children)&&count($children['items'])===1&&$children['items'][0]['id']===(string)$child,'expanded variable parent shows only matching children');
 $summary=Catalog::product($parent->get_id())['variation_summary'];
 $check($summary['current_min']==='80'&&$summary['current_max']==='100'&&$summary['regular_min']==='100'&&$summary['regular_max']==='100','variable summary preserves current and regular ranges separately');
 $viewer=wp_create_user($prefix.'viewer',wp_generate_password(30));$user=new WP_User($viewer);$user->add_cap('sdd_view_products');$user->add_cap('edit_products');wp_set_current_user($viewer);
 $hidden=$query('current');$check($hidden['total']===0&&array_sum($hidden['tab_counts'])===0,'restricted account cannot discover other authors through items or tab counts');
 wp_set_current_user($admin);$bad=Catalog::products(['scope'=>'unknown']);$check(is_wp_error($bad)&&$bad->get_error_code()==='invalid_filter','unsupported tab is rejected');
}finally{
 wp_set_current_user($admin);foreach($plans as $uuid){$wpdb->delete(Schema::table('temporary_sales'),['id'=>$uuid]);}
 foreach(array_reverse($ids) as $id){$p=wc_get_product($id);if($p){$p->delete(true);}else{wp_delete_post($id,true);}}
 if($viewer){require_once ABSPATH.'wp-admin/includes/user.php';wp_delete_user($viewer);}
 echo "Fixtures removed\n";
}
