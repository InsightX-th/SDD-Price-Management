<?php
/** Requires a dedicated disposable WordPress database. Kills only the fixture's own DB session. */
declare(strict_types=1);
use SDD\{Policy, Schema, TemporarySales, Writer};

if (wp_get_environment_type() !== 'local' || DB_NAME !== 'sdd_recovery_qa') {
    throw new RuntimeException('Run only on the disposable sdd_recovery_qa database.');
}
global $wpdb;
wp_set_current_user((int)get_users(['role'=>'administrator','number'=>1,'fields'=>'ID'])[0]);
$settings = get_option('sdd_settings');
$cache = get_option('sdd_cache_settings');
$pid = 0;
try {
    update_option('sdd_settings', array_replace(Policy::settings(), ['write_stop'=>false,'local_ack'=>true,'confirmation_mode'=>'always']));
    update_option('sdd_cache_settings', ['capture_enabled'=>false,'dispatch_enabled'=>false]);
    $product = new WC_Product_Simple();
    $product->set_name('Connection loss fixture');
    $product->set_status('publish');
    $product->set_regular_price('100');
    $product->save();
    $pid = $product->get_id();

    $run = static function (string $point) use ($wpdb, $pid): void {
        $op = wp_generate_uuid4();
        $originalSession = (int)$wpdb->get_var('SELECT CONNECTION_ID()');
        $killer = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
        $commits = 0;
        $killed = false;
        $interrupt = static function (string $sql) use ($originalSession, $killer, &$commits, &$killed, $point): string {
            if ($sql === 'COMMIT') { $commits++; }
            $atBoundary = match ($point) {
                'after_commit' => $sql === 'SELECT CONNECTION_ID()' && $commits === 2,
                'commit' => $sql === 'COMMIT' && $commits === 2,
                'dml' => $commits === 1 && str_starts_with($sql, 'UPDATE `'.$GLOBALS['wpdb']->postmeta.'`') && str_contains($sql, "'_regular_price'"),
                default => $commits === 1 && str_starts_with($sql, 'START TRANSACTION'),
            };
            if (!$killed && $atBoundary) {
                if ($killer->query('KILL CONNECTION '.$originalSession) === false) {
                    throw new RuntimeException('Could not interrupt the fixture session.');
                }
                $killed = true;
            }
            return $sql;
        };
        $payload = [
            'operation_id'=>$op,'field'=>'regular_price','base_value'=>'100',
            'base_revision'=>Writer::revision($pid, 'regular_price'),'value'=>'110',
            'acknowledgements'=>['price_change'],
        ];
        add_filter('query', $interrupt);
        try {
            $result = Writer::execute($pid, $payload);
        } finally {
            remove_filter('query', $interrupt);
            $killer->close();
        }
        $session = (int)$wpdb->get_var('SELECT CONNECTION_ID()');
        $canonical = $wpdb->get_var($wpdb->prepare('SELECT canonical_result_json FROM '.Schema::table('operation_items').' WHERE operation_id=%s',$op));
        if (!$killed || $session === $originalSession || !is_wp_error($result) || $result->get_error_code() !== 'operation_unknown') {
            throw new RuntimeException('Incorrect outcome after session loss at '.$point);
        }
        $price = Writer::fresh($pid)->get_regular_price('edit');
        if ($point === 'after_commit') {
            $stored = json_decode((string)$canonical, true);
            $replay = Writer::execute($pid, $payload);
            $events = Schema::table('events');
            if ($price !== '110' || empty($stored['event_id']) || ($stored['ok'] ?? false) !== true || $replay !== $stored
                || (int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $events WHERE operation_id=%s", $op)) !== 1) {
                throw new RuntimeException('Committed result could not be recovered without another write.');
            }
            $wpdb->delete($events, ['operation_id'=>$op]);
        } elseif ($price !== '100' || $canonical !== null) {
            throw new RuntimeException('Uncommitted price or result survived loss at '.$point);
        }
        $wpdb->delete(Schema::table('operation_items'), ['operation_id'=>$op]);
        $wpdb->delete(Schema::table('operations'), ['operation_id'=>$op]);
        echo $point === 'after_commit' ? "PASS committed result recovered without another write\n" : "PASS loss at $point leaves the original price and no false success\n";
    };
    $abandoned = wp_generate_uuid4();
    $cancelled = Writer::abandonInline($pid,$abandoned,['confirmed'=>true]);
    $late = Writer::execute($pid,['operation_id'=>$abandoned,'field'=>'regular_price','base_value'=>'100',
        'base_revision'=>Writer::revision($pid,'regular_price'),'value'=>'120','acknowledgements'=>['price_change']]);
    if ($cancelled !== ['cancelled'=>true] || !is_wp_error($late) || Writer::fresh($pid)->get_regular_price('edit') !== '100') {
        throw new RuntimeException('An abandoned command was accepted later.');
    }
    $wpdb->delete(Schema::table('operations'),['operation_id'=>$abandoned]);
    echo "PASS explicitly abandoned command cannot be written later\n";
    $run('before_write');
    $run('dml');
    $run('commit');
    $run('after_commit');
    $priceBeforeCsv = Writer::fresh($pid)->get_price('edit');
    $start = wp_date('Y-m-d H:i',time()+3600);
    $end = wp_date('Y-m-d H:i',time()+7200);
    $operations = Schema::table('operations');
    $planTable = Schema::table('temporary_sales');
    $single = wp_generate_uuid4();
    $originalSession = (int)$wpdb->get_var('SELECT CONNECTION_ID()');
    $killer = new wpdb(DB_USER,DB_PASSWORD,DB_NAME,DB_HOST);
    $interrupted = false;
    $interrupt = static function (string $sql) use ($single,$operations,$originalSession,$killer,&$interrupted): string {
        if (!$interrupted && str_starts_with($sql,'INSERT INTO `'.$operations.'`') && str_contains($sql,$single)) {
            $interrupted = $killer->query('KILL CONNECTION '.$originalSession) !== false;
        }
        return $sql;
    };
    $baseline = TemporarySales::snapshot(Writer::fresh($pid));
    add_filter('query',$interrupt);
    try {
        $result = TemporarySales::create($pid,[
            'operation_id'=>$single,'price'=>'80','start'=>str_replace(' ','T',$start),'end'=>str_replace(' ','T',$end),
            'baseline'=>$baseline,'confirmed'=>true,
        ]);
    } finally {
        remove_filter('query',$interrupt);
        $killer->close();
    }
    if (!$interrupted || !is_wp_error($result) || $result->get_error_code()!=='operation_unknown'
        || (int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $planTable WHERE id=%s",$single))
        || (int)$wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $operations WHERE operation_id=%s",$single))) {
        throw new RuntimeException('Single promotion left partial state after session loss.');
    }
    echo "PASS single promotion registration rolls back all records when the database session is lost\n";

    // Interrupt CSV registration after the plan insert, before the batch result can commit.
    $preview = (new ReflectionMethod(TemporarySales::class,'previewCsv'))
        ->invoke(null,"product_name,sale_price,starts_at,ends_at\nConnection loss fixture,80,$start,$end\n");
    if (is_wp_error($preview) || $preview['errors']) { throw new RuntimeException('Unexpected CSV preview failure.'); }
    $batch = $preview['batch'];
    $originalSession = (int)$wpdb->get_var('SELECT CONNECTION_ID()');
    $killer = new wpdb(DB_USER,DB_PASSWORD,DB_NAME,DB_HOST);
    $interrupted = false;
    $interrupt = static function (string $sql) use ($batch,$operations,$originalSession,$killer,&$interrupted): string {
        if (!$interrupted && str_starts_with($sql,'INSERT INTO `'.$operations.'`') && str_contains($sql,$batch)) {
            $interrupted = $killer->query('KILL CONNECTION '.$originalSession) !== false;
        }
        return $sql;
    };
    add_filter('query',$interrupt);
    try {
        $result = TemporarySales::importConfirm($batch,$preview['revision']);
    } finally {
        remove_filter('query',$interrupt);
        $killer->close();
        delete_transient('sdd_promo_csv_'.$batch);
    }
    $planCount = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $planTable WHERE product_id=%d",$pid));
    $batchCount = $wpdb->get_var($wpdb->prepare("SELECT COUNT(*) FROM $operations WHERE operation_id=%s",$batch));
    $price = Writer::fresh($pid)->get_price('edit');
    $outcome = is_wp_error($result) ? $result->get_error_code() : $result['status'];
    if (!$interrupted || $outcome !== 'operation_unknown' || (string)$planCount !== '0'
        || (string)$batchCount !== '0' || $price !== $priceBeforeCsv) {
        throw new RuntimeException(sprintf('CSV interruption check failed (interrupted=%d, outcome=%s, plans=%s, batches=%s, price=%s).',
            $interrupted,$outcome,$planCount,$batchCount,$price));
    }
    echo "PASS temporary CSV registration rolls back its plan when the database session is lost\n";
} finally {
    if ($pid) {
        wp_delete_post($pid, true);
        $wpdb->delete(Schema::table('field_state'), ['product_id'=>$pid]);
        $wpdb->delete(Schema::table('external_observations'), ['product_id'=>$pid]);
    }
    $settings === false ? delete_option('sdd_settings') : update_option('sdd_settings', $settings);
    $cache === false ? delete_option('sdd_cache_settings') : update_option('sdd_cache_settings', $cache);
}
