<?php
declare(strict_types=1);
namespace SDD;
final class Writer {
    private static bool $active = false;
    public static function active(): bool { return self::$active; }
    public static function productLock(int $id): string {
        global $wpdb;
        return 'sdd:'.substr(hash('sha256', DB_NAME.':'.$wpdb->prefix.':product:'.$id),0,58);
    }
    public static function fresh(int $id): \WC_Product|false {
        // WC bulk transient deletion skips option-cache invalidation when another process
        // already deleted the DB rows. Explicitly discard those request-local entries.
        foreach (['wc_var_prices_', 'wc_product_children_'] as $key) {
            wp_cache_delete('_transient_' . $key . $id, 'options');
            wp_cache_delete('_transient_timeout_' . $key . $id, 'options');
        }
        wp_cache_delete('notoptions', 'options');
        clean_post_cache($id); wp_cache_delete($id, 'post_meta'); wc_delete_product_transients($id);
        return wc_get_product($id);
    }
    public static function revision(int $id, string $field): string {
        global $wpdb;
        return (string) ($wpdb->get_var($wpdb->prepare('SELECT revision FROM ' . Schema::table('field_state') . ' WHERE product_id=%d AND field=%s', $id, $field)) ?? '0');
    }
    private static function sql(string $sql): void { global $wpdb; if ($wpdb->query($sql) === false) { throw new \RuntimeException('Database operation failed.'); } }
    private static function insert(string $table, array $row): void { global $wpdb; if ($wpdb->insert($table, $row) === false) { throw new \RuntimeException('Insert failed.'); } }
    private static function update(string $table, array $row, array $where): void { global $wpdb; if ($wpdb->update($table, $row, $where) === false) { throw new \RuntimeException('Update failed.'); } }
    private static function terminal(string $op, string $item, array|\WP_Error $result): array|\WP_Error {
        $error = is_wp_error($result);
        $encoded = $error ? ['code' => $result->get_error_code(), 'message' => $result->get_error_message(), 'data' => $result->get_error_data()] : $result;
        self::update(Schema::table('operation_items'), ['status' => $error ? ($result->get_error_code() === 'field_conflict' ? 'conflict' : 'failed') : 'succeeded', 'canonical_result_json' => wp_json_encode($encoded), 'error_code' => $error ? $result->get_error_code() : null, 'updated_at' => gmdate('Y-m-d H:i:s')], ['item_id' => $item]);
        self::update(Schema::table('operations'), ['status' => $error ? 'completed_with_errors' : 'completed', 'updated_at' => gmdate('Y-m-d H:i:s')], ['operation_id' => $op]);
        return $result;
    }
    public static function execute(int $id, array $input): array|\WP_Error {
        return self::run($id, $input, null);
    }
    /** Trusted engine only. Both fields and lifecycle state commit in the same transaction. */
    public static function transition(int $id, array $input, array $bundle): array|\WP_Error {
        return self::run($id, $input, $bundle);
    }
    public static function salePlan(int $id, mixed $in): array|\WP_Error {
        if (!is_array($in) || array_diff(array_keys($in), ['operation_id','price','dates','baseline','base_revisions','confirmed','zero_ack']) || !is_string($in['operation_id'] ?? null) || !Policy::integer($in['price'] ?? null, true) || !is_string($in['dates'] ?? null) || strlen($in['dates']) > 64 || ($in['confirmed'] ?? false) !== true || !is_array($in['baseline'] ?? null) || !is_array($in['base_revisions'] ?? null)) { return API::error('invalid_input', 'ข้อมูลแผนโปรไม่ครบหรือยังไม่ยืนยัน', 400); }
        $fields = ['regular_price','sale_price','sale_dates'];
        if (array_keys($in['baseline']) !== $fields || array_keys($in['base_revisions']) !== $fields) { return API::error('invalid_input','รูปแบบ baseline ไม่ถูกต้อง',400); }
        foreach ($fields as $f) { if (!is_string($in['baseline'][$f]) || strlen($in['baseline'][$f]) > 64 || !is_string($in['base_revisions'][$f]) || !preg_match('/^(0|[1-9][0-9]{0,17})$/D',$in['base_revisions'][$f])) { return API::error('invalid_input','ข้อมูล revision ไม่ถูกต้อง',400); } }
        if ($in['price'] === '0' && ($in['zero_ack'] ?? false) !== true) { return API::error('confirmation_required','ยืนยันราคาศูนย์ก่อนบันทึก',400); }
        $dates=Policy::normalizeDates($in['dates']); if (is_wp_error($dates)) { return $dates; }
        if ($dates !== '|' && $in['price'] === '') { return API::error('price_relation','กำหนดราคาโปรก่อนตั้งเวลา',400); }
        return self::run($id, ['operation_id'=>$in['operation_id'],'field'=>'sale_price','value'=>$in['price'],'base_value'=>$in['baseline']['sale_price'],'base_revision'=>$in['base_revisions']['sale_price'],'acknowledgements'=>['price_change','zero_price','expired_schedule']], ['expected'=>$in['baseline'],'revisions'=>$in['base_revisions'],'target'=>['sale_price'=>$in['price'],'sale_dates'=>$dates],'promotion'=>'native_sale_plan','source'=>'native_sale_plan','kind'=>'native_sale_plan','guard'=>static fn()=>true,'record'=>static function(array $values):void{}]);
    }
    private static function run(int $id, array $input, ?array $bundle): array|\WP_Error {
        global $wpdb;
        if (self::$active) { return API::error('nested_write', 'ไม่อนุญาตคำสั่งซ้อนระหว่างบันทึกสินค้า', 503); }
        $input = API::writeInput($input); if (is_wp_error($input)) { return $input; }
        if (!current_user_can('sdd_view_products') || !current_user_can('sdd_edit_products') || !Policy::accessible($id, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์แก้สินค้านี้', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'Schema ยังไม่พร้อม กรุณาตรวจการเปิดใช้ปลั๊กอิน', 503); }
        if ($input['field'] === 'sale_dates') {
            $value = Policy::normalizeDates($input['value']); if (is_wp_error($value)) { return $value; } $input['value'] = $value;
        }
        $actor = get_current_user_id(); $op = $input['operation_id']; $field = $input['field'];
        $acks = $input['acknowledgements'] ?? []; sort($acks);
        $identity = [$actor, 'inline', (string) $id, $field, $input['base_value'], $input['base_revision'], $input['value'], $acks];
        if ($bundle) { $identity[] = [$bundle['expected'], $bundle['target'], $bundle['promotion'], $bundle['source']]; }
        if (isset($bundle['revisions'])) { $identity[] = $bundle['revisions']; }
        if (isset($bundle['reverts_event_id'])) { $identity[] = $bundle['reverts_event_id']; }
        $hash = hash('sha256', wp_json_encode($identity));
        $locks = []; $transaction = false; $commitAttempted = false; $item = null;
        $ops = Schema::table('operations'); $items = Schema::table('operation_items'); $states = Schema::table('field_state'); $events = Schema::table('events');
        $parentId = get_post_type($id) === 'product_variation' ? (int)get_post_field('post_parent', $id) : 0;
        $productIds = array_values(array_unique(array_filter([$parentId,$id]))); sort($productIds, SORT_NUMERIC);
        $queueBefore = (array)($GLOBALS['wc_deferred_product_sync'] ?? []);
        self::$active = true;
        $previousErrors = $wpdb->suppress_errors(true);
        try {
            foreach (array_merge(['operation:' . $op], array_map(static fn($pid) => 'product:' . $pid, $productIds)) as $key) {
                $lock = 'sdd:' . substr(hash('sha256', DB_NAME . ':' . $wpdb->prefix . ':' . $key), 0, 58);
                if ((string) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,3)', $lock)) !== '1') { return API::error('lock_timeout', 'ข้อมูลกำลังถูกบันทึก กรุณาตรวจผลก่อนลองใหม่', 503); }
                $locks[] = $lock;
            }
            $existing = $wpdb->get_row($wpdb->prepare("SELECT * FROM $ops WHERE operation_id=%s", $op), ARRAY_A);
            if ($existing) {
                if ((int) $existing['actor_id'] !== $actor || !hash_equals($existing['payload_hash'], $hash)) { return API::error('operation_payload_mismatch', 'รหัสคำสั่งนี้ถูกใช้กับข้อมูลอื่นแล้ว', 409); }
                $stored = $wpdb->get_row($wpdb->prepare("SELECT * FROM $items WHERE operation_id=%s", $op), ARRAY_A);
                if ($stored && $stored['canonical_result_json']) {
                    $result = json_decode($stored['canonical_result_json'], true);
                    return isset($result['code']) ? new \WP_Error($result['code'], $result['message'], $result['data']) : $result;
                }
                // Pending/processing after lost connection is not automatically executed again.
                return API::error('operation_unknown', 'ยังพิสูจน์ผลคำสั่งไม่ได้ ห้ามส่งซ้ำด้วยรหัสใหม่', 409, ['operation_id' => $op]);
            }
            $p = self::fresh($id);
            if ($parentId) { self::fresh($parentId); }
            if (!$p || !Policy::accessible($id, true) || ($p->is_type('variation') && $p->get_parent_id() !== $parentId)) { return API::error('not_found', 'ไม่พบสินค้าที่รองรับ', 404); }
            $now = gmdate('Y-m-d H:i:s'); $item = wp_generate_uuid4();
            self::sql('START TRANSACTION'); $transaction = true;
            self::insert($ops, ['operation_id' => $op, 'actor_id' => $actor, 'kind' => $bundle ? ($bundle['kind'] ?? 'temporary_sale') : 'inline', 'payload_hash' => $hash, 'status' => 'running', 'created_at' => $now, 'updated_at' => $now]);
            self::insert($items, ['item_id' => $item, 'operation_id' => $op, 'product_id' => $id, 'field' => $field, 'base_value' => $input['base_value'], 'base_revision' => $input['base_revision'], 'target_value' => $input['value'], 'status' => 'processing', 'created_at' => $now, 'updated_at' => $now]);
            self::sql('COMMIT'); $transaction = false;
            self::sql('START TRANSACTION'); $transaction = true;
            $p = self::fresh($id); if ($parentId) { self::fresh($parentId); }
            if (!$p || !Policy::accessible($id, true) || ($p->is_type('variation') && $p->get_parent_id() !== $parentId)) { throw new \RuntimeException('Product scope changed.'); }
            $values = Policy::values($p); $drift = false;
            $externalPending = ExternalChanges::apply($id, $wpdb, $values);
            foreach ($values as $f => $value) {
                self::sql($wpdb->prepare("INSERT IGNORE INTO $states (product_id,field,revision,last_known_value,updated_at) VALUES (%d,%s,0,%s,%s)", $id, $f, $value, $now));
                $s = $wpdb->get_row($wpdb->prepare("SELECT * FROM $states WHERE product_id=%d AND field=%s", $id, $f), ARRAY_A);
                if ($s['last_known_value'] !== $value) {
                    // Detection is not attribution; external changes get no invented actor.
                    self::insert($events, ['product_id' => $id, 'field' => $f, 'old_value' => $s['last_known_value'], 'new_value' => $value, 'revision_before' => $s['revision'], 'revision_after' => (int) $s['revision'] + 1, 'source' => 'external_detected', 'request_id' => API::requestId(), 'created_at' => $now]);
                    $event = $wpdb->insert_id;
                    self::update($states, ['revision' => (int) $s['revision'] + 1, 'last_known_value' => $value, 'last_event_id' => $event, 'updated_at' => $now], ['product_id' => $id, 'field' => $f]); $drift = $drift || !$bundle || $f !== 'stock_status';
                }
            }
            $revision = self::revision($id, $field);
            $guardResult=$bundle?($bundle['guard'])():true;
            if ($guardResult===false) { throw new \RuntimeException('Promotion state changed.'); }
            $bundleConflict = $bundle && array_intersect_key($values, $bundle['expected']) !== $bundle['expected'];
            if (isset($bundle['revisions'])) { foreach ($bundle['revisions'] as $f=>$baseRevision) { if (self::revision($id,$f) !== $baseRevision) { $bundleConflict=true; } } }
            if ($externalPending) { $result=self::terminal($op,$item,API::error('external_backlog','กำลังตรวจการเปลี่ยนข้อมูลภายนอก กรุณาอ่านข้อมูลล่าสุดก่อนบันทึก',503)); }
            elseif (is_wp_error($guardResult)) { $result=self::terminal($op,$item,$guardResult); }
            elseif ($bundleConflict || (!$bundle && $drift) || $values[$field] !== $input['base_value'] || $revision !== $input['base_revision']) {
                $result = self::terminal($op, $item, API::error('field_conflict', 'ข้อมูลเปลี่ยนแล้ว ตรวจค่าปัจจุบันก่อนบันทึก', 409, ['current_value' => $values[$field], 'current_revision' => $revision, 'changed_by' => null, 'changed_at' => null]));
            } else {
                $validationProduct = $p;
                if (($bundle['kind'] ?? '') === 'native_sale_plan') {
                    $validationProduct = clone $p; [$from,$to] = explode('|',$bundle['target']['sale_dates']);
                    $validationProduct->set_date_on_sale_from($from===''?null:(int)$from); $validationProduct->set_date_on_sale_to($to===''?null:(int)$to);
                }
                $valid = Policy::validate($validationProduct, $field, $input['value'], $acks);
                if ($bundle && !is_wp_error($valid)) {
                    $dates = Policy::normalizeDates($bundle['target']['sale_dates']);
                    if (is_wp_error($dates) || $dates !== $bundle['target']['sale_dates']) { $valid = API::error('invalid_dates', 'ตารางโปรไม่ถูกต้อง', 400); }
                }
                if (is_wp_error($valid)) { $result = self::terminal($op, $item, $valid); }
                else {
                    $targets = $bundle ? $bundle['target'] : [$field => $input['value']];
                    $noop = !array_diff_assoc($targets, $values); $event = null;
                    if (!$noop) {
                        foreach ($targets as $targetField => $targetValue) {
                            if ($targetField === 'sale_dates') {
                                [$from,$to] = explode('|', $targetValue);
                                $p->set_date_on_sale_from($from === '' ? null : (int)$from);
                                $p->set_date_on_sale_to($to === '' ? null : (int)$to);
                            } else { $setter = 'set_' . $targetField; $p->$setter($targetValue); }
                        }
                        $p->save();
                        if ($parentId) { \WC_Product_Variable::sync(self::fresh($parentId), true); self::fresh($parentId); }
                        // Re-read persisted values to detect hooks overriding the requested field or siblings.
                        $fresh = self::fresh($id); $expected = array_replace($values, $targets);
                        if (!$fresh || Policy::values($fresh) !== $expected || ($bundle && $fresh->get_price('edit') !== ($fresh->is_on_sale('edit') ? $expected['sale_price'] : $expected['regular_price']))) { throw new \RuntimeException('Unexpected hook result.'); }
                        foreach ($targets as $targetField => $targetValue) {
                            if ($values[$targetField] === $targetValue) { continue; }
                            $before = self::revision($id, $targetField);
                            self::insert($events, ['product_id' => $id, 'field' => $targetField, 'old_value' => $values[$targetField], 'new_value' => $targetValue, 'revision_before' => $before, 'revision_after' => (int)$before + 1, 'source' => $bundle['source'] ?? 'inline', 'reverts_event_id' => $bundle['reverts_event_id'] ?? null, 'user_id' => $actor, 'operation_id' => $op, 'item_id' => $item, 'request_id' => API::requestId(), 'created_at' => $now]);
                            $event = (string)$wpdb->insert_id;
                            self::update($states, ['revision' => (int)$before + 1, 'last_known_value' => $targetValue, 'last_event_id' => $event, 'updated_at' => $now], ['product_id' => $id, 'field' => $targetField]);
                        }
                        $revision = self::revision($id, $field);
                        self::update($items, ['event_id' => $event], ['item_id' => $item]);
                    }
                    if ($bundle) { ($bundle['record'])(array_replace($values, $targets)); }
                    $extra = $bundle ? ['values'=>array_replace($values,$targets),'revisions'=>array_combine(Policy::FIELDS,array_map(static fn($f)=>self::revision($id,$f),Policy::FIELDS))] : [];
                    $result = self::terminal($op, $item, $extra + ['ok' => true, 'operation_id' => $op, 'status' => 'succeeded', 'new_value' => $input['value'], 'revision' => $revision, 'event_id' => $event, 'noop' => $noop, 'request_id' => API::requestId()]);
                }
            }
            $commitAttempted = true; self::sql('COMMIT'); $transaction = false;
            self::fresh($id);
            return $result;
        } catch (\Throwable $e) {
            $rolledBack = $transaction && !$commitAttempted && $wpdb->query('ROLLBACK') !== false;
            $transaction = false; self::fresh($id);
            API::log('writer_failure');
            // Durable processing state is deliberately retained for operator reconciliation.
            return API::error('operation_unknown', $rolledBack ? 'ยกเลิก transaction แล้ว แต่ต้องตรวจสถานะคำสั่งก่อนดำเนินการต่อ' : 'ไม่สามารถยืนยันผลคำสั่งได้ กรุณาหยุดและให้ผู้ดูแลตรวจสอบ', 409, ['operation_id' => $op]);
        } finally {
            if ($transaction) { $wpdb->query('ROLLBACK'); }
            foreach (array_reverse($locks) as $lock) { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock)); }
            if ($parentId) {
                // Explicit sync was performed under lock; preserve pre-existing queue entries only for this parent.
                $queue = array_values(array_filter((array)($GLOBALS['wc_deferred_product_sync'] ?? []), static fn($pid) => (int)$pid !== $parentId));
                $GLOBALS['wc_deferred_product_sync'] = array_merge($queue, array_values(array_filter($queueBefore, static fn($pid) => (int)$pid === $parentId)));
                self::fresh($parentId);
            }
            self::$active = false;
            $wpdb->suppress_errors($previousErrors);
        }
    }
}
