<?php
/** WP-CLI fixture for disposable Local WordPress. */
use SDD\{Policy, Schema, TemporarySales};

if (!str_contains(ABSPATH, 'Local Sites')) { throw new RuntimeException('Local only'); }
global $wpdb;
$admin = get_users(['role'=>'administrator','number'=>1,'fields'=>'ID']);
wp_set_current_user((int)$admin[0]);
$settings = get_option('sdd_settings');
$products = []; $batches = []; $parent = null;
$assert = static function (bool $ok, string $label): void {
    if (!$ok) { throw new RuntimeException($label); }
    echo "PASS $label\n";
};
$parse = new ReflectionMethod(TemporarySales::class,'previewCsv');
$table = Schema::table('temporary_sales');
$ops = Schema::table('operations');
$start = wp_date('Y-m-d H:i', time()+3600);
$end = wp_date('Y-m-d H:i', time()+7200);
$header = "\xEF\xBB\xBFproduct_name,sale_price,starts_at,ends_at\r\n";
$suffix = ",80,$start,$end\r\n";
try {
    update_option('sdd_settings', array_replace(Policy::settings(),['write_stop'=>false,'local_ack'=>true]));
    $model = 'SDF'.random_int(100000,999999).'S';
    $prefix = '000-sdd-csv-'.wp_generate_password(8,false).'-';
    foreach (['a,quoted','b'] as $suffixSku) {
        if ($suffixSku === 'b') {
            $parent = new WC_Product_Variable();
            $parent->set_name($prefix.'รุ่นตัวเลือก');
            $color = new WC_Product_Attribute();
            $color->set_name('Color');
            $color->set_options(['Black']);
            $color->set_variation(true);
            $parent->set_attributes([$color]);
            $parent->set_status('publish');
            $parent->save();
            $p = new WC_Product_Variation();
            $p->set_parent_id($parent->get_id());
            $p->set_attributes(['color'=>'Black']);
        } else {
            $p = new WC_Product_Simple();
            $p->set_name($prefix.$suffixSku.' '.$model);
        }
        $p->set_status('publish');
        $p->set_sku($prefix.$suffixSku);
        $p->set_regular_price('100');
        $p->save();
        $products[] = $p;
    }
    $first = '"'.get_post_field('post_title',$products[0]->get_id(),'raw').'"'.$suffix;
    $second = get_post_field('post_title',$products[1]->get_id(),'raw').$suffix;
    $sameName = get_post_field('post_title',$products[0]->get_id(),'raw');
    $wpdb->update($wpdb->posts,['post_title'=>$sameName],['ID'=>$parent->get_id()]);
    $ambiguous = $parse->invoke(null,$header.$first);
    $assert($ambiguous['errors'][0]['selectable'] && str_contains($ambiguous['errors'][0]['message'],'หลายรายการ'),'duplicate names are blocked rather than guessed');
    $batches[] = $ambiguous['batch'];
    $wpdb->update($wpdb->posts,['post_title'=>$parent->get_name()],['ID'=>$parent->get_id()]);
    $invalid = $parse->invoke(null,$header.$first."\r\n".$first);
    $assert($invalid['errors'][0]['row'] === 4,'duplicate blocks confirmation and preserves physical row number');
    $broken = $parse->invoke(null,$header.get_post_field('post_title',$products[1]->get_id(),'raw').',80,'.$start.',"'.$end);
    $assert($broken['errors'][0]['row'] === 2,'unterminated CSV quote blocks confirmation');
    $batches[] = $invalid['batch'];
    $batches[] = $broken['batch'];
    $tooHigh = $parse->invoke(null,$header.'"'.$sameName.'",101,'.$start.','.$end."\r\n");
    $batches[] = $tooHigh['batch'];
    $assert($tooHigh['errors'][0]['edit']==='price' && str_contains($tooHigh['errors'][0]['message'],'100 บาท'),'price above the reference can be corrected without choosing another product');
    $correction = $parse->invoke(null,$header.'"'.$sameName.'",0,'.$start.','.$start."\r\n");
    $batches[] = $correction['batch'];
    $assert($correction['errors'][0]['edit']==='price' && $correction['errors'][0]['values']['price']==='0','invalid price keeps its original value for correction');
    $priceFixed = TemporarySales::importSelect($correction['batch'],['row'=>2,'action'=>'edit','revision'=>$correction['revision'],'values'=>['price'=>'80']]);
    $assert($priceFixed['errors'][0]['edit']==='until' && $priceFixed['errors'][0]['values']['price']==='80','valid price is preserved while a date still needs correction');
    $fixed = TemporarySales::importSelect($correction['batch'],['row'=>2,'action'=>'edit','revision'=>$priceFixed['revision'],'values'=>['from'=>$start,'until'=>$end]]);
    $assert(!$fixed['errors'] && $fixed['rows'][0]['price']==='80' && $fixed['rows'][0]['until']===$end,'corrected row returns to ready with the same product');
    $staleEdit = TemporarySales::importConfirm($correction['batch'],$priceFixed['revision']);
    $assert(is_wp_error($staleEdit) && $staleEdit->get_error_code()==='review_required','confirmation requires the corrected revision');
    $preview = $parse->invoke(null,$header.$first.$second);
    if (is_wp_error($preview)) { throw new RuntimeException($preview->get_error_message()); }
    $batch = $preview['batch'];
    $assert(is_string($batch) && count($preview['rows']) === 2,'BOM and quoted product name parse with a valid preview');
    $assert(is_int($preview['expires_at'])&&is_int($preview['server_time'])
        && $preview['expires_at']-$preview['server_time']<=900&&$preview['expires_at']-$preview['server_time']>=890,'preview exposes a server-based 15-minute expiry');
    $assert($preview['rows'][0]['regular_price'] === '100','ready review exposes its checked regular-price ceiling');
    $batches[] = $batch;
    $cancelDraft = $parse->invoke(null,$header.$first.$second);
    $batches[] = $cancelDraft['batch'];
    $ownedDraft = get_transient('sdd_promo_csv_'.$cancelDraft['batch']);
    set_transient('sdd_promo_csv_'.$cancelDraft['batch'],array_replace($ownedDraft,['actor'=>0]),900);
    $foreignCancel = TemporarySales::importCancel($cancelDraft['batch']);
    $assert(is_wp_error($foreignCancel) && get_transient('sdd_promo_csv_'.$cancelDraft['batch'])!==false,'even an authorized importer cannot cancel another owner draft');
    set_transient('sdd_promo_csv_'.$cancelDraft['batch'],$ownedDraft,900);
    $denyCancelLock = static fn($sql) => str_contains($sql,'GET_LOCK(') ? 'SELECT 0' : $sql;
    add_filter('query',$denyCancelLock);
    try{$lockedCancel=TemporarySales::importCancel($cancelDraft['batch']);}
    finally{remove_filter('query',$denyCancelLock);}
    $assert(is_wp_error($lockedCancel) && $lockedCancel->get_error_code()==='lock_timeout'
        && get_transient('sdd_promo_csv_'.$cancelDraft['batch'])!==false,'busy batch lock prevents draft deletion');
    $cancelled = TemporarySales::importCancel($cancelDraft['batch']);
    $assert(!is_wp_error($cancelled) && $cancelled['status']==='cancelled'
        && get_transient('sdd_promo_csv_'.$cancelDraft['batch'])===false,'cancel removes an uncommitted draft');
    $assert(is_wp_error(TemporarySales::importConfirm($cancelDraft['batch'],$cancelDraft['revision'])), 'cancelled draft cannot later confirm');
    $assert(!$wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE product_id IN (%d,%d)",$products[0]->get_id(),$products[1]->get_id())), 'cancelling creates no promotion plans');
    $cancelErrors = TemporarySales::importCancel($broken['batch']);
    $assert(!is_wp_error($cancelErrors) && $cancelErrors['status']==='cancelled','draft with CSV issues can also be cancelled');
    $runningBatch = wp_generate_uuid4();$batches[]=$runningBatch;
    $wpdb->insert($ops,['operation_id'=>$runningBatch,'actor_id'=>get_current_user_id(),'kind'=>'permanent_csv',
        'payload_hash'=>str_repeat('a',64),'preview_json'=>wp_json_encode(['revision'=>1,'rows'=>[['row'=>2]],'results'=>[]]),
        'status'=>'running','created_at'=>gmdate('Y-m-d H:i:s'),'updated_at'=>gmdate('Y-m-d H:i:s')]);
    $cannotStop = TemporarySales::importCancel($runningBatch);
    $assert(is_wp_error($cannotStop) && $cannotStop->get_error_code()==='import_started'
        && TemporarySales::importStatus($runningBatch)['status']==='running','running permanent batch cannot be discarded and remains recoverable');
    $products[0]->set_regular_price('105');
    $products[0]->save();
    $conflict = TemporarySales::importConfirm($batch,$preview['revision']);
    $assert(is_wp_error($conflict) && $conflict->get_error_code()==='preview_changed','stale row prevents the whole import');
    $assert(!$wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE product_id IN (%d,%d)",$products[0]->get_id(),$products[1]->get_id())),'conflict leaves both products without plans');
    $ready = $parse->invoke(null,$header.$first.$second);
    if (is_wp_error($ready)) { throw new RuntimeException($ready->get_error_message()); }
    if (!$ready['batch']) { throw new RuntimeException(wp_json_encode($ready['errors'], JSON_UNESCAPED_UNICODE)); }
    $batch = $ready['batch'];
    $batches[] = $batch;
    $short = strtolower(substr($model,0,3).' '.substr($model,3));
    $modelPreview = $parse->invoke(null,$header.$short.$suffix);
    $batches[] = $modelPreview['batch'];
    $assert(!$modelPreview['errors'] && $modelPreview['rows'][0]['method']==='model' && $modelPreview['rows'][0]['id']===$products[0]->get_id(),'short model matches a unique full model');
    $dashPreview = $parse->invoke(null,$header.str_replace(' ','-',$short).$suffix);
    $batches[] = $dashPreview['batch'];
    $assert(!$dashPreview['errors'] && $dashPreview['rows'][0]['id']===$products[0]->get_id(),'hyphen and space match the same model');
    $originalTitle = get_post_field('post_title',$products[1]->get_id(),'raw');
    $wpdb->update($wpdb->posts,['post_title'=>$model.'X สีดำ'],['ID'=>$products[1]->get_id()]);
    $boundary = $parse->invoke(null,$header.$short.$suffix);
    $batches[] = $boundary['batch'];
    $assert(!$boundary['errors'] && $boundary['rows'][0]['id']===$products[0]->get_id(),'model prefix excludes the longer model');
    $wpdb->update($wpdb->posts,['post_title'=>$model.' สีดำ'],['ID'=>$products[1]->get_id()]);
    $multiple = $parse->invoke(null,$header.$short.$suffix);
    $batches[] = $multiple['batch'];
    $assert($multiple['errors'][0]['selectable'] && !$multiple['rows'],'multiple model variants require manual selection');
    $candidates = TemporarySales::importSearch($multiple['batch'],$short);
    $assert(count($candidates['items'])===2,'search shows eligible matching products');
    $similar = TemporarySales::importSearch($multiple['batch'],substr($short,0,-1).'Z');
    $assert(in_array($products[0]->get_id(),array_column($similar['items'],'id'),true),'nearby names are suggested for manual choice');
    $selected = TemporarySales::importSelect($multiple['batch'],['row'=>2,'product_id'=>$products[0]->get_id()]);
    $assert(!$selected['errors'] && $selected['rows'][0]['method']==='manual' && $selected['rows'][0]['price']==='80'
        && $selected['rows'][0]['from']===$start && $selected['rows'][0]['until']===$end,'manual choice preserves file price and dates');
    $stale = TemporarySales::importConfirm($multiple['batch'],$multiple['revision']);
    $assert(is_wp_error($stale) && $stale->get_error_code()==='review_required','older review revision cannot confirm');
    $duplicate = TemporarySales::importSelect($invalid['batch'],['row'=>4,'product_id'=>$products[0]->get_id()]);
    $assert(is_wp_error($duplicate) && $duplicate->get_error_code()==='duplicate_product','duplicate selection is rejected with a clear reason');
    $used = TemporarySales::importSearch($invalid['batch'],$short,4);
    $assert(($used['items'][0]['used_row']??null)===2,'search labels products already used by another row');
    $swap = TemporarySales::importSelect($multiple['batch'],['row'=>2,'action'=>'remove','revision'=>$selected['revision']]);
    $assert(!$swap['rows'] && $swap['removed']===[2],'remove leaves an empty batch that cannot be confirmed');
    $assert(is_wp_error(TemporarySales::importConfirm($multiple['batch'],$swap['revision'])),'empty batch is rejected');
    $restore = TemporarySales::importSelect($multiple['batch'],['row'=>2,'action'=>'restore','revision'=>$swap['revision']]);
    $assert(!$restore['removed'] && count($restore['rows'])===1,'undo restores the removed row');
    $kept = TemporarySales::importSelect($invalid['batch'],['row'=>4,'product_id'=>$products[0]->get_id(),'replace_row'=>2,'revision'=>$invalid['revision']]);
    $assert(!$kept['errors'] && $kept['removed']===[2] && $kept['rows'][0]['row']===4,'keep later duplicate replaces the earlier row');
    $undone = TemporarySales::importSelect($invalid['batch'],['row'=>2,'action'=>'restore','revision'=>$kept['revision']]);
    $assert(!$undone['removed'] && $undone['errors'][0]['row']===4,'undo restores both original duplicate rows');
    wp_set_current_user(0);
    $assert(is_wp_error(TemporarySales::importSearch($multiple['batch'],$short))
        && is_wp_error(TemporarySales::importSelect($multiple['batch'],['row'=>2,'product_id'=>$products[0]->get_id()])),'unauthorized user cannot search or select');
    $assert(is_wp_error(TemporarySales::importCancel($multiple['batch'])),'unauthorized user cannot cancel a draft');
    wp_set_current_user((int)$admin[0]);
    $wpdb->update($wpdb->posts,['post_title'=>$originalTitle],['ID'=>$products[1]->get_id()]);
    $partial = $parse->invoke(null,$header.$first.$second.'สินค้าที่ไม่มีในระบบทดสอบ'.$suffix);
    $batches[] = $partial['batch'];
    $ready = TemporarySales::importSelect($partial['batch'],['row'=>4,'action'=>'remove','revision'=>$partial['revision']]);
    $batch = $ready['batch'];
    $oldRevision = $ready['revision'];
    $changedReady = TemporarySales::importSelect($batch,['row'=>2,'action'=>'update','revision'=>$oldRevision,
        'values'=>['price'=>'79','from'=>$start,'until'=>$end]]);
    $assert(!is_wp_error($changedReady) && $changedReady['rows'][0]['price']==='79','ready row can update its price and dates');
    $badReady = TemporarySales::importSelect($batch,['row'=>2,'action'=>'update','revision'=>$changedReady['revision'],
        'values'=>['price'=>'9999','from'=>$start,'until'=>$end]]);
    $unchanged = TemporarySales::importStatus($batch);
    $assert(is_wp_error($badReady) && $unchanged['rows'][0]['price']==='79'
        && $unchanged['revision']===$changedReady['revision'],'invalid ready-row edit preserves the last reviewed value');
    $assert(is_wp_error(TemporarySales::importConfirm($batch,$oldRevision)),'old preview cannot confirm after a ready-row edit');
    $assert($changedReady['expires_at']===$partial['expires_at'],'editing rows never extends the original preview expiry');
    $ready = $changedReady;
    // Force the batch marker write to fail after the two plans have been inserted.
    $reject = static fn($sql) => str_starts_with($sql, 'INSERT INTO `'.$ops.'`') && str_contains($sql, "'temporary_csv'") ? 'SELECT * FROM sdd_intentional_missing_table' : $sql;
    $oldSuppress = $wpdb->suppress_errors(true);
    add_filter('query',$reject);
    try { $failure = TemporarySales::importConfirm($batch,$ready['revision']); }
    finally { remove_filter('query',$reject); $wpdb->suppress_errors($oldSuppress); }
    $assert(is_wp_error($failure) && !$wpdb->get_var($wpdb->prepare("SELECT id FROM $table WHERE product_id IN (%d,%d)",$products[0]->get_id(),$products[1]->get_id())),'failure after plan inserts rolls back the entire batch');
    $done = TemporarySales::importConfirm($batch,$ready['revision']);
    if (is_wp_error($done)) { throw new RuntimeException($done->get_error_message()); }
    $assert(!is_wp_error($done) && $done['count'] === 2,'successful confirmation creates both plans');
    $cancelDone = TemporarySales::importCancel($batch);
    $assert(is_wp_error($cancelDone) && $cancelDone->get_error_code()==='import_started'
        && TemporarySales::importStatus($batch)===$done,'completed temporary batch cannot be cancelled or lose its result');
    $assert(TemporarySales::importConfirm($batch,$ready['revision'])===$done && TemporarySales::importStatus($batch)===$done,'confirmation replay and status return the same durable result');
    $assert((int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $table WHERE product_id IN (%d,%d)",$products[0]->get_id(),$products[1]->get_id()))===2,'retry does not duplicate plans');
    $permanentProduct = new WC_Product_Simple();
    $permanentProduct->set_name($prefix.'โปรถาวร');
    $permanentProduct->set_status('publish');
    $permanentProduct->set_regular_price('100');
    $permanentProduct->set_sale_price('90');
    $permanentProduct->set_date_on_sale_from(time()+3600);
    $permanentProduct->set_date_on_sale_to(time()+7200);
    $permanentProduct->save();
    $products[] = $permanentProduct;
    $permanent = $parse->invoke(null,"product_name,sale_price\n".$permanentProduct->get_name().",80\n",'permanent');
    if (is_wp_error($permanent)) { throw new RuntimeException($permanent->get_error_message()); }
    $batches[] = $permanent['batch'];
    $assert($permanent['mode']==='permanent' && !$permanent['errors'],'permanent template accepts a product and price without dates');
    $assert(wc_get_product($permanentProduct->get_id())->get_sale_price('edit')==='90','permanent preview does not change the price');
    $assert($permanent['rows'][0]['clears_schedule'] === true,'permanent review identifies an existing schedule that confirmation will clear');
    $editedPermanent = TemporarySales::importSelect($permanent['batch'],['row'=>2,'action'=>'update',
        'revision'=>$permanent['revision'],'values'=>['price'=>'80']]);
    $assert(!is_wp_error($editedPermanent) && !$editedPermanent['errors'],'permanent ready row edits require only a price');
    $permanent = $editedPermanent;
    $applied = TemporarySales::importConfirm($permanent['batch'],$permanent['revision']);
    if (is_wp_error($applied)) { throw new RuntimeException($applied->get_error_message()); }
    if ($applied['errors']) { throw new RuntimeException($applied['errors'][0]['message']); }
    $fresh = SDD\Writer::fresh($permanentProduct->get_id());
    $assert($applied['status']==='completed' && $applied['count']===1 && $fresh->get_price('edit')==='80','permanent price takes effect on confirmation');
    $assert(TemporarySales::snapshot($fresh)['sale_dates']==='|','permanent import clears previous sale dates');
    $cancelPermanent = TemporarySales::importCancel($permanent['batch']);
    $assert(is_wp_error($cancelPermanent) && $cancelPermanent->get_error_code()==='import_started'
        && TemporarySales::importStatus($permanent['batch'])===$applied,'completed permanent batch cannot be cancelled or lose its result');
    $assert(TemporarySales::importConfirm($permanent['batch'],$permanent['revision'])===$applied,'permanent batch retry returns the existing result');
    $assert(is_wp_error($parse->invoke(null,$header.$first,'permanent')),'permanent mode rejects the temporary template');
} catch (Throwable $e) { fwrite(STDERR, $e->getMessage()."\n"); throw $e; } finally {
    foreach ($batches as $batch) {
        delete_transient('sdd_promo_csv_'.$batch);
        $wpdb->delete($ops,['operation_id'=>$batch]);
    }
    foreach ($products as $product) {
        $id = $product->get_id();
        foreach ($wpdb->get_col($wpdb->prepare("SELECT id FROM $table WHERE product_id=%d",$id)) as $op) {
            wp_clear_scheduled_hook('sdd_temporary_sale_tick',[$op,'starts_at']);
            wp_clear_scheduled_hook('sdd_temporary_sale_tick',[$op,'ends_at']);
            $wpdb->delete($ops,['operation_id'=>$op]);
        }
        foreach ($wpdb->get_col($wpdb->prepare('SELECT operation_id FROM '.Schema::table('operation_items').' WHERE product_id=%d',$id)) as $op) {
            $wpdb->delete($ops,['operation_id'=>$op]);
        }
        foreach (['temporary_sales','operation_items','events','field_state'] as $name) {
            $wpdb->delete(Schema::table($name),['product_id'=>$id]);
        }
        $product->delete(true);
    }
    if ($parent) { $parent->delete(true); }
    update_option('sdd_settings',$settings);
}
