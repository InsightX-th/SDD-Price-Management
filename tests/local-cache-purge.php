<?php
/** WP-CLI on disposable Local only. Cloudflare HTTP is intercepted; fixtures/settings are restored. */
use SDD\{API,CacheSchema,CachePurge,CacheURLs,CloudflareClient,Policy,Schema,Writer,WorkspaceSync,Bulk,TemporarySales,SystemLogs};
global $wpdb;
if (wp_get_environment_type()==='production' && !str_contains(ABSPATH,'Local Sites')) { throw new RuntimeException('Disposable Local site required.'); }
$admin=get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);wp_set_current_user((int)$admin[0]);
if (!defined('SDD_CF_ZONE_ID')) { define('SDD_CF_ZONE_ID',str_repeat('a',32)); }
if (!defined('SDD_CF_API_TOKEN')) { define('SDD_CF_API_TOKEN','fixture-not-a-real-token'); }
if (!defined('SDD_CF_LIVE_VERIFIED')) { define('SDD_CF_LIVE_VERIFIED',true); }
$failures=[];$checks=0;
$check=static function(bool $ok,string $label)use(&$failures,&$checks):void{$checks++;echo ($ok?'PASS ':'FAIL ').$label."\n";if(!$ok)$failures[]=$label;};
$original=[];foreach(['sdd_settings','sdd_cache_settings','sdd_cf_connection','sdd_cache_settings_audit','sdd_cache_worker_at','sdd_cache_throttle_until','woocommerce_shop_page_id','woocommerce_cart_page_id'] as $key){$original[$key]=get_option($key,null);}
$products=[];$posts=[];$opids=[];$start=null;
$home=static fn($url)=>preg_replace('#^https?://[^/]+#','https://sdd-cache.test',$url);add_filter('home_url',$home);
$httpCalls=[];$httpMode='success';$duringHTTP=null;
$http=static function($pre,$args,$url)use(&$httpCalls,&$httpMode,&$duringHTTP){
 if(!str_starts_with($url,'https://api.cloudflare.com/client/v4/zones/'))return new WP_Error('fixture_network_disabled');
 $httpCalls[]=json_decode($args['body']??'{}',true);
 if($duringHTTP){$callback=$duringHTTP;$duringHTTP=null;$callback();}
 if($httpMode==='network')return new WP_Error('fixture_network');
 $status=match($httpMode){'429'=>429,'403'=>403,default=>200};
 return ['headers'=>$httpMode==='429'?['retry-after'=>'120']:[],'body'=>wp_json_encode(['success'=>$httpMode==='success','errors'=>$httpMode==='success'?[]:[['code'=>999,'message'=>'fixture-secret-must-not-leak']]]),'response'=>['code'=>$status,'message'=>'fixture'],'cookies'=>[]];
};add_filter('pre_http_request',$http,10,3);
$job=static function(int $id)use($wpdb){return $wpdb->get_row($wpdb->prepare('SELECT * FROM '.CacheSchema::table('outbox').' WHERE id=%d',$id),ARRAY_A);};
$latest=static function(int $pid)use($wpdb):int{return (int)$wpdb->get_var($wpdb->prepare('SELECT MAX(id) FROM '.CacheSchema::table('outbox').' WHERE product_id=%d',$pid));};
$settings=['capture_enabled'=>true,'dispatch_enabled'=>false,'dry_run'=>true,'inventory_ack'=>true,'per_page'=>100,'devices'=>[],'extra_urls'=>[]];
$write=static function(int $pid,string $value,?array $input=null)use(&$opids){$p=Writer::fresh($pid);$input??=['operation_id'=>wp_generate_uuid4(),'field'=>'regular_price','value'=>$value,'base_value'=>$p->get_regular_price('edit'),'base_revision'=>Writer::revision($pid,'regular_price'),'acknowledgements'=>['price_change']];$opids[]=$input['operation_id'];return [Writer::execute($pid,$input),$input];};
$run=static function(int $id)use($wpdb,$job){$wpdb->update(CacheSchema::table('outbox'),['lease_until'=>0],['id'=>$id]);for($i=0;$i<150;$i++){CachePurge::dispatch();$row=$job($id);if(in_array($row['status'],['accepted','simulated','needs_attention','retry_wait'],true))return $row;}throw new RuntimeException('Fixture queue did not settle');};
try{
 $check(CacheSchema::migrate()&&CacheSchema::ready(),'optional schema migrates with InnoDB and unique indexes');
 if(!CacheSchema::ready())throw new RuntimeException('Cache schema unavailable');
 $start=(int)$wpdb->get_var('SELECT COALESCE(MAX(id),0) FROM '.CacheSchema::table('outbox'));
 if((int)$wpdb->get_var("SELECT COUNT(*) FROM ".CacheSchema::table('outbox')." WHERE status NOT IN ('accepted','simulated')"))throw new RuntimeException('Resolve unrelated local cache jobs before running fixtures');
 update_option('sdd_settings',array_replace(Policy::settings(),['confirmation_mode'=>'always','write_stop'=>false,'local_ack'=>true]),false);
 $shop=wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Cache fixture shop','post_name'=>'cache-fixture-shop']);$posts[]=$shop;update_option('woocommerce_shop_page_id',$shop);
 $cart=wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Cache fixture cart','post_name'=>'cache-fixture-cart']);$posts[]=$cart;update_option('woocommerce_cart_page_id',$cart);
 $p=new WC_Product_Simple();$p->set_name('SDD cache purge fixture');$p->set_status('publish');$p->set_regular_price('10000');$p->set_manage_stock(false);$p->save();$pid=$p->get_id();$products[]=$pid;
 $check(CacheURLs::allowed(get_permalink($pid))&&!CacheURLs::allowed('https://sdd-cache.test.evil.test/p/')&&!CacheURLs::allowed('https://other.test/p/'),'URL inventory enforces exact canonical host');
 $check(!CacheURLs::allowed(wc_get_cart_url())&&!CacheURLs::allowed('https://sdd-cache.test/wp-json/sdd/v1/products')&&!CacheURLs::allowed('https://sdd-cache.test/?rest_route=/sdd/v1/products'),'private pages and REST routes are excluded');
 $check(!CacheURLs::validPayload(['url'=>get_permalink($pid),'headers'=>['Authorization'=>'secret']],false),'unexpected cache-key headers are rejected');
 $snapshot=['entries'=>[['url'=>'https://sdd-cache.test/shop/','pages'=>3]],'devices'=>['desktop','mobile','tablet'],'pretty'=>true,'pagination_base'=>'page'];$b=CacheURLs::batch($snapshot,0,4);$b2=CacheURLs::batch($snapshot,$b['cursor'],20);
 $check(count($b['items'])===4&&count($b2['items'])===5&&$b2['done']&&str_contains($b2['items'][4]['url'],'page/3/'),'pagination/device enumeration resumes without dropping targets');
 $check(is_wp_error(CachePurge::saveSettings($settings+['token'=>'forbidden'])),'settings reject token and unknown keys');
 $check(!is_wp_error(CachePurge::saveSettings($settings)),'administrator enables dry-run capture without a real token');
 [$r,$input]=$write($pid,'10100');$id=$latest($pid);
 $check(!is_wp_error($r)&&$r['ok']&&$job($id)['status']==='pending','committed writer creates durable pending outbox');
 $check($job($id)['item_id']!==''&&$job($id)['operation_id']===$input['operation_id'],'outbox links immutable operation and item identity');
 [$again]=$write($pid,'10100',$input);$check($again===$r&&$latest($pid)===$id,'lost-response replay returns canonical result without duplicate outbox');
 [$noop]=$write($pid,'10100');$check(!is_wp_error($noop)&&$noop['noop']&&$latest($pid)===$id,'no-op produces no new purge event');
 $bad=$input;$bad['operation_id']=wp_generate_uuid4();$bad['base_value']='1';$opids[]=$bad['operation_id'];$conflict=Writer::execute($pid,$bad);
 $check(is_wp_error($conflict)&&$conflict->get_error_code()==='field_conflict'&&$latest($pid)===$id,'conflicted write produces no outbox');
 $settings['dispatch_enabled']=true;update_option('sdd_cache_settings',$settings,false);$dryCalls=count($httpCalls);$row=$run($id);
 $check($row['status']==='simulated'&&count($httpCalls)===$dryCalls,'dry-run enumerates and completes without any Cloudflare HTTP');
 $check(CachePurge::statuses([$pid])[(string)$pid]['state']==='simulated','status never calls a dry-run accepted or verified');
 $before=Writer::fresh($pid)->get_regular_price('edit');$beforeRev=Writer::revision($pid,'regular_price');
 $break=static fn($sql)=>str_starts_with($sql,'INSERT INTO `'.CacheSchema::table('outbox').'`')?'INVALID OUTBOX FIXTURE SQL':$sql;
 add_filter('query',$break);[$failed]=$write($pid,'10200');remove_filter('query',$break);
 $check(is_wp_error($failed)&&Writer::fresh($pid)->get_regular_price('edit')===$before&&Writer::revision($pid,'regular_price')===$beforeRev,'outbox insertion failure rolls back price and audit revision');
 $check($latest($pid)===$id,'rolled-back write leaves no purge event');
 // Reproduce commit-to-scheduler crash gap by saving while dispatch is disabled.
 $settings['dry_run']=false;$settings['dispatch_enabled']=false;update_option('sdd_cache_settings',$settings,false);[$live]=$write($pid,'10300');$liveId=$latest($pid);
 $check(!is_wp_error($live)&&$job($liveId)['mode']==='live'&&$job($liveId)['status']==='pending','committed live job survives with dispatch paused');
 $settings['dispatch_enabled']=true;update_option('sdd_cache_settings',$settings,false);$beforeHTTP=count($httpCalls);$row=$run($liveId);
 $check($row['status']==='accepted'&&count($httpCalls)>$beforeHTTP,'recovery dispatches committed work without an admin request');
 $check(Writer::fresh($pid)->get_regular_price('edit')==='10300','purge worker never rewrites product price');
 // API success is stricter than HTTP 200.
 $httpMode='false';$response=CloudflareClient::purge([['url'=>get_permalink($pid)]]);
 $check(!$response['ok']&&$response['code']==='cloudflare_200','HTTP 200 with success=false is not accepted');
 $httpMode='network';$check(CloudflareClient::purge([['url'=>get_permalink($pid)]])['code']==='network','network failures return sanitized retryable errors');
 $httpMode='429';[$r]=$write($pid,'10400');$retryId=$latest($pid);$retryStarted=time();$row=$run($retryId);
 $target=$wpdb->get_row($wpdb->prepare('SELECT * FROM '.CacheSchema::table('targets')." WHERE outbox_id=%d AND status='retry_wait' ORDER BY id LIMIT 1",$retryId),ARRAY_A);
 $check($row['status']==='retry_wait'&&(int)$target['next_attempt_at']>=$retryStarted+120,'429 respects Retry-After and retains the job');
 $check((int)get_option('sdd_cache_throttle_until')>=$retryStarted+120,'429 throttles the site dispatcher');
 $check(!str_contains(wp_json_encode(CachePurge::health()),'fixture-secret-must-not-leak')&&!str_contains(wp_json_encode(CachePurge::health()),'fixture-not-a-real-token'),'REST health does not leak token or provider response body');
 $httpMode='success';update_option('sdd_cache_throttle_until',0,false);$retry=CachePurge::retry($retryId);$row=$run($retryId);
 $check(!is_wp_error($retry)&&$row['status']==='accepted'&&(int)$row['last_retry_actor']===(int)$admin[0]&&Writer::fresh($pid)->get_regular_price('edit')==='10400','manual replay retries purge only and preserves price');
 // A new committed update arriving while the old HTTP is in flight must remain pending.
 [$r]=$write($pid,'10500');$oldId=$latest($pid);$newId=0;
 $duringHTTP=static function()use($write,$pid,$latest,&$newId){[$r]=$write($pid,'10600');if(is_wp_error($r))throw new RuntimeException('Concurrent fixture write failed');$newId=$latest($pid);};
 $run($oldId);$check($newId>$oldId&&$job($newId)['status']==='pending','new update during purge is not acknowledged by the old request');
 $run($newId);$check($job($newId)['status']==='accepted','new update receives its own post-commit purge');
 // Permanent authorization failure pauses sending and preserves committed prices.
 $httpMode='403';[$r]=$write($pid,'10700');$authId=$latest($pid);$row=$run($authId);
 $check($row['status']==='needs_attention'&&!CachePurge::settings()['dispatch_enabled'],'403 pauses dispatcher and exposes an actionable state');
 $check(Writer::fresh($pid)->get_regular_price('edit')==='10700','authorization failure does not roll back a committed price');
 $httpMode='success';$settings['dispatch_enabled']=true;update_option('sdd_cache_settings',$settings,false);CachePurge::retry($authId);$run($authId);
 // Lease recovery after HTTP completion before acknowledgement.
 [$r]=$write($pid,'10800');$crashId=$latest($pid);
 $interrupt=static function($sql){if(str_starts_with($sql,'UPDATE `'.CacheSchema::table('targets').'`')&&str_contains($sql,"'accepted'"))return 'INVALID ACK FIXTURE SQL';return $sql;};
 $wpdb->update(CacheSchema::table('outbox'),['lease_until'=>0],['id'=>$crashId]);$errors=$wpdb->suppress_errors(true);add_filter('query',$interrupt);
 for($i=0;$i<100;$i++){CachePurge::dispatch();if((int)$job($crashId)['enumerated'])break;}
 remove_filter('query',$interrupt);$wpdb->suppress_errors($errors);
 $check($job($crashId)['status']==='processing','failed acknowledgement does not report accepted');
 $wpdb->query($wpdb->prepare('UPDATE '.CacheSchema::table('targets')." SET lease_until=0,next_attempt_at=0 WHERE outbox_id=%d",$crashId));$run($crashId);
 $check($job($crashId)['status']==='accepted','expired lease recovers an HTTP-to-ack crash');
 // UI read scope and role separation.
 $sync=WorkspaceSync::read(['ids'=>[(string)$pid],'client_id'=>wp_generate_uuid4()]);
 $check(!is_wp_error($sync)&&isset($sync['cache_updates']->{(string)$pid}),'existing heartbeat includes scoped batch cache status');
 $manager=wp_insert_user(['user_login'=>'sdd-cache-fixture-'.wp_generate_password(8,false),'user_pass'=>wp_generate_password(),'role'=>'shop_manager']);
 wp_set_current_user((int)$manager);
 $check(is_wp_error(CachePurge::saveSettings($settings))&&is_wp_error(CachePurge::retry($authId)),'shop manager cannot configure Cloudflare or replay jobs');
 wp_set_current_user((int)$admin[0]);require_once ABSPATH.'wp-admin/includes/user.php';wp_delete_user($manager);
 $entry=SystemLogs::parseLine(gmdate('c').' WARNING cache_purge_failure');
 $check($entry&&$entry['event']==='cache_purge_failure','cache errors are readable through the existing sanitized technical log viewer');
 $check(str_contains(CachePurge::protectsOperation(),'NOT EXISTS'),'business retention protects operations with unresolved cache work');
 // Scheduler exceptions after the commit must never change the price result.
 if(function_exists('as_unschedule_all_actions'))as_unschedule_all_actions('sdd_cache_dispatch',[],'sdd-cache');
 $throwSchedule=static function(){throw new RuntimeException('fixture scheduler failure');};add_filter('pre_as_schedule_single_action',$throwSchedule);
 [$scheduledFailure]=$write($pid,'10850');remove_filter('pre_as_schedule_single_action',$throwSchedule);$scheduleId=$latest($pid);
 $check(!is_wp_error($scheduledFailure)&&$scheduledFailure['ok']&&Writer::fresh($pid)->get_regular_price('edit')==='10850','scheduler exception after COMMIT does not turn a successful price write into unknown');
 CachePurge::recover();$run($scheduleId);
 // An existing future retry action must not hold up a new, earlier write.
 if(function_exists('as_unschedule_all_actions'))as_unschedule_all_actions('sdd_cache_dispatch',[],'sdd-cache');
 as_schedule_single_action(time()+3600,'sdd_cache_dispatch',[],'sdd-cache');[$urgent]=$write($pid,'10875');$urgentId=$latest($pid);
 $soon=as_get_scheduled_actions(['hook'=>'sdd_cache_dispatch','group'=>'sdd-cache','status'=>'pending','date'=>time()+15,'date_compare'=>'<=','per_page'=>1],'ids');
 $check(!is_wp_error($urgent)&&count($soon)===1,'future retry does not delay a newly committed urgent job');$run($urgentId);
 // Additional entry points must all use the same durable boundary.
 $settings['dry_run']=true;update_option('sdd_cache_settings',$settings,false);
 $parent=new WC_Product_Variable();$parent->set_name('SDD cache variable fixture');$parent->set_status('publish');$parent->save();$products[]=$parent->get_id();
 $variation=new WC_Product_Variation();$variation->set_parent_id($parent->get_id());$variation->set_status('publish');$variation->set_regular_price('1000');$variation->save();$products[]=$variation->get_id();
 [$vr]=$write($variation->get_id(),'1100');$vid=$latest($variation->get_id());$vs=json_decode($job($vid)['snapshot_json'],true);
 $check(!is_wp_error($vr)&&(int)$job($vid)['parent_id']===$parent->get_id()&&$vs['entries'][0]['url']===get_permalink($parent->get_id()),'variation changes invalidate the public parent URL');
 $check(CachePurge::statuses([$parent->get_id()])[(string)$parent->get_id()]['pending']===1,'parent row reflects pending variation jobs');$run($vid);
 $preview=Bulk::preview(['ids'=>[(string)$pid],'action'=>'adjust_price','params'=>['target'=>'regular_price','basis'=>'regular_price','direction'=>'increase','unit'=>'baht','amount'=>'100']]);
 if(is_wp_error($preview))throw new RuntimeException('Bulk fixture preview: '.$preview->get_error_message());
 $bulk=Bulk::execute($preview['operation_id'],['confirmation_hash'=>$preview['payload_hash'],'acknowledgements'=>['price_change']]);$bulkJob=$latest($pid);
 $check(!is_wp_error($bulk)&&$bulk['status']==='completed'&&$job($bulkJob)['source']==='bulk_action'&&($bulk['cache_updates']['pending']??0)===1,'bulk execution creates outbox through the writer');$run($bulkJob);
 $event=(string)$bulk['items'][0]['result']['event_id'];$rollback=Bulk::rollbackPreview($event,[]);
 if(is_wp_error($rollback))throw new RuntimeException('Rollback fixture preview: '.$rollback->get_error_message());
 $rolled=Bulk::execute($rollback['operation_id'],['confirmation_hash'=>$rollback['payload_hash'],'acknowledgements'=>['price_change']]);$rollbackJob=$latest($pid);
 $check(!is_wp_error($rolled)&&$rolled['status']==='completed'&&$job($rollbackJob)['source']==='rollback','rollback creates a new invalidation without replaying the old price operation');$run($rollbackJob);
 $beforePlan=$latest($pid);$planId=wp_generate_uuid4();
 $plan=TemporarySales::create($pid,['operation_id'=>$planId,'price'=>'9000','start'=>wp_date('Y-m-d\TH:i',time()+3600),'end'=>wp_date('Y-m-d\TH:i',time()+7200),'baseline'=>TemporarySales::snapshot(Writer::fresh($pid)),'confirmed'=>true]);
 $check(!is_wp_error($plan)&&$plan['promotion']['status']==='pending'&&$latest($pid)===$beforePlan,'future promotion registration alone does not claim a price/cache update');
 $wpdb->update(Schema::table('temporary_sales'),['starts_at'=>time()-60],['id'=>$planId]);TemporarySales::tick($planId);$startJob=$latest($pid);
 $check($startJob>$beforePlan&&$job($startJob)['source']==='temporary_start'&&Writer::fresh($pid)->get_sale_price('edit')==='9000','actual promotion start creates a durable invalidation');$run($startJob);
 $wpdb->update(Schema::table('temporary_sales'),['ends_at'=>time()-1],['id'=>$planId]);TemporarySales::tick($planId);$endJob=$latest($pid);
 $check($endJob>$startJob&&$job($endJob)['source']==='temporary_restore'&&Writer::fresh($pid)->get_sale_price('edit')==='','actual promotion restoration creates its own invalidation');$run($endJob);
 wp_clear_scheduled_hook('sdd_temporary_sale_tick',[$planId,'starts_at']);wp_clear_scheduled_hook('sdd_temporary_sale_tick',[$planId,'ends_at']);
 $settings['capture_enabled']=false;$settings['dispatch_enabled']=false;update_option('sdd_cache_settings',$settings,false);$old=$latest($pid);[$r]=$write($pid,'10900');
 $check(!is_wp_error($r)&&$latest($pid)===$old,'capture off preserves existing write behavior without adding work');
 $check(!is_wp_error($r)&&!isset($r['cache_status']),'price canonical result is independent of live cache status');
 $check(CacheURLs::validPayload(['url'=>'https://sdd-cache.test/product-category/audio/','kind'=>'prefix'],false)&&!CacheURLs::validPayload(['url'=>'https://sdd-cache.test/','kind'=>'prefix'],false),'prefix invalidation cannot expand to the whole site root');
 $callsBefore=count($httpCalls);$prefixResult=CloudflareClient::purge([['url'=>'https://sdd-cache.test/product-category/audio/','kind'=>'prefix']]);
 $check($prefixResult['ok']&&($httpCalls[$callsBefore]['prefixes'][0]??'')==='sdd-cache.test/product-category/audio/','directory purge covers pagination and cache-key variants without page counts');
 $settings['dry_run']=true;update_option('sdd_cache_settings',$settings,false);
 $auto=CacheURLs::snapshot(Writer::fresh($pid),$settings);$autoFiles=CacheURLs::batch($auto,0,100)['items'];
 $check(count(array_filter($autoFiles,static fn($f)=>($f['kind']??'')==='prefix'))>0&&count(array_filter($autoFiles,static fn($f)=>($f['url']??'')==='https://sdd-cache.test/'))===4,'automatic inventory combines directory targets and four homepage variants');
 $newToken='fixture-encrypted-connection-token';$connection=CloudflareClient::connect(['zone_id'=>str_repeat('a',32),'api_token'=>$newToken]);
 $check(!is_wp_error($connection)&&CloudflareClient::verified(),'connection is configured and checked entirely through the plugin');
 $stored=get_option('sdd_cf_connection');$check(!str_contains(wp_json_encode($stored),$newToken)&&!str_contains(wp_json_encode(CachePurge::health()),$newToken),'saved connection is encrypted and token is absent from REST responses');
 $againConnection=CloudflareClient::connect(['zone_id'=>str_repeat('a',32),'api_token'=>'']);$check(!is_wp_error($againConnection),'blank token preserves the saved secret during connection recheck');
 $httpMode='403';$beforeConnection=get_option('sdd_cf_connection');$failedConnection=CloudflareClient::connect(['zone_id'=>str_repeat('b',32),'api_token'=>'invalid-fixture-connection-token']);
 $check(is_wp_error($failedConnection)&&get_option('sdd_cf_connection')===$beforeConnection,'failed connection cannot replace working credentials');$httpMode='success';
 wp_set_current_user(0);$check(is_wp_error(CloudflareClient::connect(['zone_id'=>str_repeat('a',32),'api_token'=>$newToken])),'connection management rejects unauthenticated users');wp_set_current_user((int)$admin[0]);
 echo "$checks checks executed\n";
}finally{
 remove_filter('pre_http_request',$http);remove_filter('home_url',$home);
 if($start!==null&&CacheSchema::ready()){
  $wpdb->query($wpdb->prepare('DELETE t FROM '.CacheSchema::table('targets').' t JOIN '.CacheSchema::table('outbox').' j ON j.id=t.outbox_id WHERE j.id>%d',$start));
  $wpdb->query($wpdb->prepare('DELETE FROM '.CacheSchema::table('outbox').' WHERE id>%d',$start));
 }
 foreach($products as $pid){
  $ops=$wpdb->get_col($wpdb->prepare('SELECT DISTINCT operation_id FROM '.Schema::table('operation_items').' WHERE product_id=%d',$pid));
  foreach($ops as $op){$wpdb->delete(Schema::table('operation_items'),['operation_id'=>$op]);$wpdb->delete(Schema::table('operations'),['operation_id'=>$op]);}
  $eventIds=$wpdb->get_col($wpdb->prepare('SELECT id FROM '.Schema::table('events').' WHERE product_id=%d',$pid));
  foreach($eventIds as $event){$wpdb->delete(Schema::table('publications'),['event_id'=>$event]);}
  wp_delete_post($pid,true);
  foreach(['events','field_state','external_observations','temporary_sales'] as $table){$wpdb->delete(Schema::table($table),['product_id'=>$pid]);}
 }
 foreach($posts as $post){wp_delete_post($post,true);}
 foreach($original as $key=>$value){if($value===null)delete_option($key);else update_option($key,$value,false);}
 CachePurge::deactivate();CachePurge::schedule();
 echo "Fixture products, queue rows and settings cleaned up; no Cloudflare request sent\n";
}
if($failures)throw new RuntimeException('Failed: '.implode('; ',$failures));
