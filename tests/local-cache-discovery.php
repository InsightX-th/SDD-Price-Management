<?php
/** Disposable Local integration fixture. No network requests. */
use SDD\{CacheDiscovery,CacheURLs,CachePurge};
if (!str_contains(ABSPATH,'Local Sites')) { throw new RuntimeException('Local only'); }
$ids=[]; $checks=0;
$check=static function($ok,$label)use(&$checks){if(!$ok)throw new RuntimeException($label);$checks++;echo "PASS $label\n";};
try {
 foreach ([['page','publish','[ux_products ids="123"]',''],['post','publish','[products category="speakers"]',''],['page','publish','<!-- wp:woocommerce/product-collection {} /-->',''],['page','draft','[products]',''],['page','publish','[products]','secret'],['page','publish','Plain article','']] as [$type,$status,$content,$password]) {
  $ids[]=wp_insert_post(['post_type'=>$type,'post_status'=>$status,'post_title'=>'Discovery fixture','post_content'=>$content,'post_password'=>$password]);
 }
 $found=array_column(CacheDiscovery::inventory(),'id');
 foreach(array_slice($ids,0,3) as $id)$check(in_array($id,$found,true),'published product display discovered');
 foreach(array_slice($ids,3) as $id)$check(!in_array($id,$found,true),'draft/password/plain content excluded');
 update_post_meta($ids[5],'_elementor_data','[{"widgetType":"woocommerce-products"}]');
 $check(in_array($ids[5],array_column(CacheDiscovery::inventory(),'id'),true),'Elementor metadata invalidates inventory');
 wp_update_post(['ID'=>$ids[0],'post_status'=>'draft']);
 $check(!in_array($ids[0],array_column(CacheDiscovery::inventory(),'id'),true),'unpublished page removed immediately');
 $check(CacheDiscovery::containsProducts('[block id="footer"]'),'shared UX block conservatively included');
 $check(CacheDiscovery::containsProducts('<!-- wp:block {"ref":123} /-->'),'reusable block conservatively included');
 $check(!CacheDiscovery::containsProducts('Just a product price: 100'),'static text does not imply dynamic price');
 $product=new WC_Product_Simple();$product->set_name('Discovery snapshot fixture');$product->set_status('publish');$product->set_regular_price('100');$product->save();$ids[]=$product->get_id();
 $snapshot=CacheURLs::snapshot($product,array_replace(CachePurge::settings(),['dry_run'=>true]));
 $check(in_array(get_permalink($ids[1]),array_column($snapshot['entries'],'url'),true),'automatic page enters durable purge snapshot without extra URLs');
 wp_update_post(['ID'=>$ids[1],'post_content'=>'[products ids="'.$product->get_id().'"]']);
 $check(in_array(get_permalink($ids[1]),array_column(CacheDiscovery::urls(true,$product->get_id()),'url'),true),'fixed product page is included for the matching product');
 $check(!in_array(get_permalink($ids[1]),array_column(CacheDiscovery::urls(true,PHP_INT_MAX),'url'),true),'fixed product page is skipped for unrelated products');
 echo "$checks checks passed\n";
} finally { foreach($ids as $id)wp_delete_post($id,true);CacheDiscovery::invalidate(); }
