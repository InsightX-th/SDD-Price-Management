<?php
declare(strict_types=1);
namespace SDD;
/** Temporary promotions preserve a separate, immutable native-sale snapshot. */
final class TemporarySales {
    private static int $ownProduct = 0;
    private static bool $booted = false;
    public static function boot(): void {
        if (self::$booted) { return; } self::$booted = true;
        add_filter('cron_schedules', static function ($s) { $s['sdd_minute'] = ['interval' => 60, 'display' => 'SoundDD every minute']; return $s; });
        add_action('sdd_temporary_sale_tick', [self::class, 'tick'], 10, 2);
        add_action('sdd_temporary_sale_scan', [self::class, 'scan']);
        foreach (['added_post_meta','updated_post_meta','deleted_post_meta'] as $hook) { add_action($hook, [self::class, 'changed'], 10, 4); }
        add_action('woocommerce_after_product_object_save', [self::class, 'nativeSaved'], 99);
        add_action('admin_init', static function () {
            if (current_user_can('sdd_manage_settings') && get_option('sdd_schema_version') !== Schema::VERSION) { Schema::activate(); }
            if (Schema::ready() && self::hasLive()) { self::scheduleScan(); }
        });
    }
    private static function table(): string { return Schema::table('temporary_sales'); }
    private static function hasLive(): bool { global $wpdb; return (bool)$wpdb->get_var('SELECT id FROM ' . self::table() . " WHERE status IN ('pending','active') LIMIT 1"); }
    private static function scheduleScan(): void {
        if (!wp_next_scheduled('sdd_temporary_sale_scan')) { wp_schedule_event(time()+60, 'sdd_minute', 'sdd_temporary_sale_scan'); }
    }
    public static function snapshot(\WC_Product $p): array { return array_intersect_key(Policy::values($p), array_flip(['regular_price','sale_price','sale_dates'])); }
    public static function hasOriginalSale(array $base): bool { return isset($base['sale_price']) && $base['sale_price'] !== '' && $base['sale_price'] !== '0'; }
    public static function reference(array $base, int $at): array {
        return ['price'=>$base['regular_price'],'reason'=>'ใช้ราคาปกติเป็นราคาอ้างอิง'];
    }
    private static function native(): bool {
        return doing_action('wc_product_start_scheduled_sale') || doing_action('wc_product_end_scheduled_sale') || doing_action('woocommerce_scheduled_sales');
    }
    public static function changed($metaId, $id, $key, $value): void {
        if ((int)$id === self::$ownProduct || !in_array($key, ['_regular_price','_sale_price','_sale_price_dates_from','_sale_price_dates_to','_price'], true) || get_option('sdd_schema_version') !== Schema::VERSION) { return; }
        global $wpdb;
        // Native schedule changes while pending are incorporated only after its CRUD save.
        $states = self::native() ? "('active')" : "('pending','active')";
        $rows = $wpdb->get_results($wpdb->prepare('SELECT id,status FROM ' . self::table() . " WHERE product_id=%d AND status IN $states", $id), ARRAY_A);
        // wpdb->update validates each column's charset. A raw Thai UPDATE on a mixed
        // ASCII UUID / utf8 table is rejected by wpdb's whole-query charset check.
        foreach ($rows as $row) {
            $saved = $wpdb->update(self::table(), ['status'=>'needs_review','message'=>'พบการแก้ราคา/วันโปรภายนอก หยุดเริ่มและคืนอัตโนมัติ กรุณาตรวจราคา','updated_at'=>gmdate('Y-m-d H:i:s')], ['id'=>$row['id'],'status'=>$row['status']]);
            if ($saved === false) { $settings = Policy::settings(); $settings['write_stop'] = true; update_option('sdd_settings', $settings, false); API::log('writer_failure'); }
        }
    }
    public static function nativeSaved($p): void {
        if (!self::native() || self::$ownProduct === $p->get_id() || get_option('sdd_schema_version') !== Schema::VERSION) { return; }
        global $wpdb;
        $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . self::table() . " WHERE product_id=%d AND status='pending'", $p->get_id()), ARRAY_A);
        foreach ($rows as $row) {
            $expected = json_decode($row['expected_json'], true); $actual = self::snapshot($p);
            $legacyEnd = array_intersect_key($expected,array_flip(['regular_price','sale_price','sale_dates'])); $legacyEnd['sale_price'] = ''; $legacyEnd['sale_dates'] = '|';
            $allowedEnd = (doing_action('wc_product_end_scheduled_sale') || doing_action('woocommerce_scheduled_sales')) && $actual === $legacyEnd;
            if ($actual !== array_intersect_key($expected,array_flip(['regular_price','sale_price','sale_dates'])) && !$allowedEnd) {
                self::update($row['id'], ['status'=>'needs_review','message'=>'พบการเปลี่ยนราคาแทรกในงาน native schedule ต้องตรวจสอบ']);
            } else { self::update($row['id'], ['expected_json'=>wp_json_encode(array_merge($actual,array_intersect_key($expected,array_flip(['_revive_expired']))))]); }
        }
    }
    private static function update(string $id, array $data): void {
        global $wpdb; $data['updated_at'] = gmdate('Y-m-d H:i:s');
        if ($wpdb->update(self::table(), $data, ['id' => $id]) === false) { throw new \RuntimeException('Promotion state write failed.'); }
    }
    private static function updateState(string $id, string $before, array $data): void {
        global $wpdb; $data['updated_at'] = gmdate('Y-m-d H:i:s');
        if ($wpdb->update(self::table(), $data, ['id'=>$id,'status'=>$before]) !== 1) { throw new \RuntimeException('Promotion state changed during write.'); }
    }
    private static function row(string $id): ?array { global $wpdb; return $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . self::table() . ' WHERE id=%s', $id), ARRAY_A) ?: null; }
    private static function publicRow(array $r): array {
        $original = json_decode($r['original_json'], true);
        return ['id' => $r['id'], 'product_id' => (string)$r['product_id'], 'status' => $r['status'], 'price' => $r['sale_price'], 'starts_at' => (string)$r['starts_at'], 'ends_at' => (string)$r['ends_at'], 'original' => $original, 'message' => $r['message'], 'updated_at' => str_replace(' ', 'T', $r['updated_at']) . 'Z', 'revive_expired' => (bool)(json_decode($r['expected_json'], true)['_revive_expired'] ?? false), 'reference_price' => self::reference($original, (int)$r['starts_at'])['price']];
    }
    public static function listing(int $id): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !Policy::accessible($id, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์จัดการโปรสินค้านี้', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'Schema ไม่พร้อม', 503); }
        global $wpdb;
        $rows = $wpdb->get_results($wpdb->prepare('SELECT * FROM ' . self::table() . ' WHERE product_id=%d ORDER BY created_at DESC,id DESC LIMIT 5', $id), ARRAY_A);
        $p = Writer::fresh($id);
        return ['items' => array_map([self::class,'publicRow'], $rows), 'baseline' => $p ? self::snapshot($p) : null, 'current_price' => $p ? $p->get_price('edit') : null, 'automation' => ['blocked' => (bool)Policy::globalReasons()], 'timezone' => wp_timezone_string(), 'server_time' => (string)time()];
    }
    private static function uuid(mixed $s): bool { return is_string($s) && preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $s) === 1; }
    private static function parseTime(mixed $s): ?int {
        if (!is_string($s) || !preg_match('/^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/D', $s)) { return null; }
        $d = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $s, wp_timezone());
        return $d && $d->format('Y-m-d\TH:i') === $s ? $d->getTimestamp() : null;
    }
    private static function lock(string $key): ?string {
        global $wpdb; $lock = 'sdd:' . substr(hash('sha256', DB_NAME . ':' . $wpdb->prefix . ':' . $key), 0, 58);
        return (string)$wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s,3)', $lock)) === '1' ? $lock : null;
    }
    private static function unlock(array $locks): void { global $wpdb; foreach (array_reverse($locks) as $lock) { $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock)); } }
    public static function create(int $id, mixed $in): array|\WP_Error {
        $result = self::register($id, $in);
        if (is_wp_error($result)) { return $result; }
        $row = self::row($result['operation_id']);
        if ($row && $row['status'] === 'pending' && (int)$row['starts_at'] <= time()) {
            // Registration has committed and released its locks before the shared writer runs.
            self::process($row['id'], false);
            $latest = self::row($row['id']);
            if ($latest) { $result['promotion'] = self::publicRow($latest); }
        }
        // Success confirms durable plan registration; promotion status reports active/review/pending.
        return $result;
    }
    private static function register(int $id, mixed $in): array|\WP_Error {
        global $wpdb;
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !current_user_can('sdd_view_products') || !Policy::accessible($id, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์จัดการโปรสินค้านี้', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'Schema ไม่พร้อม', 503); }
        if (!is_array($in) || array_diff(array_keys($in), ['operation_id','price','start','end','baseline','confirmed','zero_ack','revive_expired']) || !self::uuid($in['operation_id'] ?? null) || !Policy::integer($in['price'] ?? null) || ($in['confirmed'] ?? false) !== true || !is_array($in['baseline'] ?? null) || array_keys($in['baseline']) !== ['regular_price','sale_price','sale_dates'] || count(array_filter($in['baseline'], 'is_string')) !== 3 || (($in['price'] ?? '') === '0' && ($in['zero_ack'] ?? false) !== true)) { return API::error('invalid_input', 'ต้องยืนยันราคาและข้อมูลโปรให้ครบ', 400); }
        if (array_key_exists('revive_expired', $in) && !is_bool($in['revive_expired'])) { return API::error('invalid_input', 'ตัวเลือกคืนโปรเดิมต้องเป็น boolean', 400); }
        $revive = $in['revive_expired'] ?? false;
        $start = self::parseTime($in['start'] ?? null); $end = self::parseTime($in['end'] ?? null);
        if ($start === null || $end === null || $end <= $start) { return API::error('invalid_dates', 'วันเวลาสิ้นสุดต้องหลังวันเวลาเริ่ม', 400); }
        $op = $in['operation_id']; $actor = get_current_user_id();
        $identity=[$actor,$id,$in['price'],$start,$end,$in['baseline']];
        if ($revive) { $identity[]=['revive_expired'=>true]; }
        $hash = hash('sha256', wp_json_encode($identity));
        $locks = []; $tx = false;
        try {
            $ids = [$id]; if (get_post_type($id) === 'product_variation') { $ids[] = (int)get_post_field('post_parent', $id); } sort($ids, SORT_NUMERIC);
            foreach (array_merge(['operation:'.$op], array_map(static fn($v) => 'product:'.$v, array_unique($ids))) as $key) {
                $lock = self::lock($key); if (!$lock) { return API::error('lock_timeout', 'ข้อมูลกำลังบันทึก ตรวจผลก่อนลองใหม่', 503); } $locks[] = $lock;
            }
            if ($existing = self::row($op)) {
                if ((int)$existing['actor_id'] !== $actor || !hash_equals($existing['payload_hash'], $hash)) { return API::error('operation_payload_mismatch', 'รหัสคำสั่งถูกใช้กับข้อมูลอื่น', 409); }
                self::schedule($existing); return ['ok'=>true,'promotion'=>self::publicRow($existing),'operation_id'=>$op];
            }
            if ($wpdb->get_var($wpdb->prepare('SELECT operation_id FROM ' . Schema::table('operations') . ' WHERE operation_id=%s', $op))) { return API::error('operation_payload_mismatch', 'รหัสคำสั่งถูกใช้แล้ว', 409); }
            if ($end <= time()) { return API::error('invalid_dates', 'เวลาจบต้องยังไม่ผ่าน หากเวลาเริ่มผ่านแล้วจะเริ่มทันที', 400); }
            $base = self::validatePlan($id, $in['price'], $start, $end, $in['baseline'], $revive);
            if (is_wp_error($base)) { return $base; }
            if ($wpdb->query('START TRANSACTION') === false) { throw new \RuntimeException('Transaction failed.'); } $tx = true;
            [$row, $result] = self::insertPlan($id, $op, $hash, $in['price'], $start, $end, $base, $revive);
            if ($wpdb->query('COMMIT') === false) { throw new \RuntimeException('Commit outcome unknown.'); } $tx = false;
            self::schedule($row); return $result;
        } catch (\Throwable $e) { API::log('writer_failure'); return API::error('operation_unknown', 'ตรวจผลคำสั่งก่อนส่งใหม่ ห้ามเปลี่ยนรหัสคำสั่ง', 409, ['operation_id'=>$op]); }
        finally { if ($tx) { $wpdb->query('ROLLBACK'); } self::unlock($locks); }
    }
    private static function validatePlan(int $id, string $price, int $start, int $end, ?array $baseline, bool $revive): array|\WP_Error {
        global $wpdb;
        $p = Writer::fresh($id);
        if (!$p || !Policy::accessible($id, true) || !in_array($p->get_type(), ['simple','variation'], true)) { return API::error('forbidden', 'ชนิดสินค้าไม่รองรับ', 403); }
        if ($reasons = Policy::fieldReasons($p, 'sale_price')) { return API::error('write_unavailable', implode('; ', $reasons), 503); }
        $base = self::snapshot($p);
        $originalEnd=explode('|',$base['sale_dates'])[1];
        if ($revive && (!self::hasOriginalSale($base) || $originalEnd==='' || (int)$originalEnd>max(time(),$end))) { return API::error('invalid_input','ใช้ตัวเลือกนี้ได้เมื่อมีโปรเดิมที่หมดอายุภายในช่วงโปรชั่วคราว',400); }
        if ($baseline !== null && $base !== $baseline) { return API::error('field_conflict', 'ราคาเปลี่ยนแล้ว โหลดข้อมูลและยืนยันใหม่', 409); }
        if (($base['sale_price'] !== '' && (int)$base['sale_price'] >= (int)$base['regular_price']) || ($base['sale_price'] === '' && $base['sale_dates'] !== '|') || is_wp_error(Policy::normalizeDates($base['sale_dates']))) { return API::error('price_relation', 'ราคาโปรเดิมหรือช่วงเวลาโปรเดิมของสินค้าไม่ถูกต้อง กรุณาตรวจใน WooCommerce', 400); }
        $reference = (int)self::reference($base,max(time(),$start))['price'];
        if ((int)$price >= $reference) {
            return API::error('price_relation','ราคาโปร '.number_format((int)$price).' บาท ต้องต่ำกว่าราคาอ้างอิง '.number_format($reference).' บาท',400,
                ['field'=>'price','reference_price'=>$reference]);
        }
        $existing = $wpdb->get_var($wpdb->prepare('SELECT id FROM ' . self::table() . " WHERE product_id=%d AND status IN ('pending','active','needs_review') LIMIT 1", $id));
        if ($wpdb->last_error) { return API::error('promotion_read_failed', 'ตรวจโปรเดิมไม่ได้ กรุณาลองอีกครั้ง', 503); }
        if ($existing) { return API::error('promotion_exists', 'มีโปรที่รอเริ่ม/กำลังใช้/รอตรวจแล้ว ต้องปิดรายการเดิมก่อน', 409); }
        return $base;
    }
    private static function insertPlan(int $id, string $op, string $hash, string $price, int $start, int $end, array $base, bool $revive): array {
        global $wpdb; $actor = get_current_user_id();
        $now = gmdate('Y-m-d H:i:s');
        $row = ['id'=>$op,'product_id'=>$id,'actor_id'=>$actor,'payload_hash'=>$hash,'status'=>'pending','starts_at'=>$start,'ends_at'=>$end,'sale_price'=>$price,'original_json'=>wp_json_encode($base),'expected_json'=>wp_json_encode(array_merge($base,['_revive_expired'=>$revive])),'start_operation'=>wp_generate_uuid4(),'end_operation'=>wp_generate_uuid4(),'message'=>'','created_at'=>$now,'updated_at'=>$now];
        $result = ['ok'=>true,'promotion'=>self::publicRow($row),'operation_id'=>$op]; $item = wp_generate_uuid4();
        foreach ([[self::table(),$row], [Schema::table('operations'),['operation_id'=>$op,'actor_id'=>$actor,'kind'=>'temporary_plan','payload_hash'=>$hash,'status'=>'completed','created_at'=>$now,'updated_at'=>$now]], [Schema::table('operation_items'),['item_id'=>$item,'operation_id'=>$op,'product_id'=>$id,'field'=>'temporary_sale','base_value'=>$base['sale_price'],'base_revision'=>Writer::revision($id,'sale_price'),'target_value'=>$price,'status'=>'succeeded','canonical_result_json'=>wp_json_encode($result),'created_at'=>$now,'updated_at'=>$now]], [Schema::table('events'),['product_id'=>$id,'field'=>'temporary_sale','old_value'=>'','new_value'=>$op,'revision_before'=>0,'revision_after'=>0,'source'=>'temporary_sale_created','user_id'=>$actor,'operation_id'=>$op,'item_id'=>$item,'request_id'=>API::requestId(),'created_at'=>$now]]] as [$table,$data]) { if ($wpdb->insert($table,$data) === false) { throw new \RuntimeException('Plan registration failed.'); } }
        return [$row, $result];
    }
    public static function canImport(): bool {
        return current_user_can('sdd_manage_settings') && current_user_can('sdd_edit_products')
            && current_user_can('sdd_view_products') && current_user_can('sdd_bulk_edit');
    }

    private static function nameMatches(string $name): array {
        global $wpdb;
        return array_map('intval', $wpdb->get_col($wpdb->prepare(
            "SELECT ID FROM $wpdb->posts WHERE post_type IN ('product','product_variation')
             AND post_status='publish' AND BINARY post_title=%s LIMIT 2", $name
        )));
    }

    private static function modelPattern(string $name): ?string {
        if (strlen($name) > 40 || !preg_match('/^[A-Z0-9]+(?:[ -]+[A-Z0-9]+)*$/iD', $name)
            || !preg_match('/[a-z]/i', $name) || !preg_match('/[0-9]/', $name)) { return null; }
        $parts = preg_split('/[ -]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/i', strtolower($name));
        return '(^|[^a-z0-9])'.implode('[[:space:]-]*', $parts).'([^a-z0-9]|$)';
    }

    private static function modelMatches(string $name): array {
        if (!$pattern = self::modelPattern($name)) { return []; }
        global $wpdb;
        return array_map('intval', $wpdb->get_col($wpdb->prepare(
            "SELECT ID FROM $wpdb->posts WHERE post_type IN ('product','product_variation')
             AND post_status='publish' AND LOWER(post_title) REGEXP %s LIMIT 2", $pattern
        )));
    }

    private static function importReview(string $batch, array $draft): array {
        $ready = []; $issues = $draft['errors']; $seen = [];
        foreach ($draft['rows'] as $row) {
            if (!empty($draft['removed'][$row['row']])) { continue; }
            $id = $row['id'] ?? null;
            if (!$id || isset($row['message']) || isset($seen[$id])) {
                $issues[] = ['row'=>$row['row'],'name'=>$row['input'],'selectable'=>true,'id'=>$id,
                    'price'=>$row['price'],'from'=>$row['from'],'until'=>$row['until'],'duplicate_row'=>$seen[$id] ?? null,
                    'message'=>$row['message'] ?? ('สินค้าเดียวกับแถว '.$seen[$id].' กรุณาเลือกสินค้าอื่นหรือแก้ไฟล์')];
                continue;
            }
            $seen[$id] = $row['row'];
            $row['regular_price'] = $row['base']['regular_price'] ?? null;
            $row['clears_schedule'] = !empty($row['permanent']) && ($row['base']['sale_dates'] ?? '|') !== '|';
            unset($row['base'],$row['revisions']);
            $ready[] = $row;
        }
        foreach ($issues as &$issue) {
            if (!isset($issue['edit'])) { continue; }
            $matches = self::nameMatches($issue['name']);
            if (!$matches) { $matches = self::modelMatches($issue['name']); }
            $issue['price_context'] = null;
            if (count($matches) !== 1 || !Policy::accessible($matches[0],true)) { continue; }
            $product = wc_get_product($matches[0]);
            if (!$product || !$product->is_type(['simple','variation'])) { continue; }
            $issue['price_context'] = ['current'=>$product->get_price('edit'),'regular'=>$product->get_regular_price('edit')];
        }
        unset($issue);
        usort($issues, static fn($a,$b) => $a['row'] <=> $b['row']);
        return ['batch'=>$batch,'revision'=>$draft['revision'],'total'=>$draft['total'],'expires_at'=>(int)$draft['expires'],'server_time'=>time(),
            'mode'=>$draft['mode'] ?? 'temporary','errors'=>$issues,'rows'=>$ready,'removed'=>array_keys($draft['removed'] ?? []),
            'removed_items'=>array_values(array_map(static fn($row) => [
                'row'=>$row['row'],'name'=>$row['name'] ?? $row['input'],'input'=>$row['input'],
            ],array_filter($draft['rows'],static fn($row) => !empty($draft['removed'][$row['row']]))))];
    }

    private static function importDraft(string $batch): array|\WP_Error {
        if (!self::canImport()) { return API::error('forbidden', 'ไม่มีสิทธิ์นำเข้าโปร', 403); }
        if (!self::uuid($batch) || !Schema::ready()) { return API::error('invalid_batch', 'ไม่พบชุดนำเข้า', 404); }
        $draft = get_transient('sdd_promo_csv_'.$batch);
        if (!is_array($draft) || ($draft['actor'] ?? null) !== get_current_user_id()
            || ($draft['expires'] ?? 0) <= time() || $draft['timezone'] !== wp_timezone_string()) {
            return API::error('preview_expired', 'ผลตรวจหมดอายุ กรุณาอัปโหลดไฟล์อีกครั้ง', 404);
        }
        return $draft;
    }

    public static function importSearch(string $batch, mixed $query, int $rowNumber = 0): array|\WP_Error {
        $draft = self::importDraft($batch);
        if (is_wp_error($draft)) { return $draft; }
        if (!is_string($query) || mb_strlen(trim($query)) < 2 || mb_strlen($query) > 200) {
            return API::error('invalid_search', 'พิมพ์ชื่อ รุ่น หรือแบรนด์อย่างน้อย 2 ตัวอักษร', 400);
        }
        global $wpdb;
        $query = trim($query);
        $words = preg_split('/\s+/u', $query, -1, PREG_SPLIT_NO_EMPTY);
        $title = "CONCAT(p.post_title,' ',COALESCE(parent.post_title,''))";
        if (!$words) { return API::error('invalid_search', 'พิมพ์ชื่อ รุ่น หรือแบรนด์', 400); }
        $checks = []; $suggestions = [];
        foreach (array_slice($words,0,12) as $word) {
            $like = '%'.$wpdb->esc_like($word).'%';
            if (mb_strlen($word) >= 4) {
                $prefix = mb_substr($word,0,mb_strlen($word)-1);
                $suggestions[] = $wpdb->prepare("$title LIKE %s", '%'.$wpdb->esc_like($prefix).'%');
            }
            $checks[] = $wpdb->prepare("($title LIKE %s OR EXISTS (
                SELECT 1 FROM $wpdb->term_relationships tr
                JOIN $wpdb->term_taxonomy tt ON tt.term_taxonomy_id=tr.term_taxonomy_id
                JOIN $wpdb->terms term ON term.term_id=tt.term_id
                WHERE tr.object_id IN (p.ID,p.post_parent) AND tt.taxonomy IN ('product_brand','product_tag')
                AND term.name LIKE %s))", $like, $like);
        }
        $match = '('.implode(' AND ', $checks).')';
        if ($pattern = self::modelPattern($query)) {
            $match .= $wpdb->prepare(" OR LOWER(p.post_title) REGEXP %s", $pattern);
        }
        $suggested = $suggestions ? ' OR ('.implode(' OR ', $suggestions).')' : '';
        $ids = $wpdb->get_col("SELECT p.ID FROM $wpdb->posts p LEFT JOIN $wpdb->posts parent ON parent.ID=p.post_parent
            WHERE p.post_status='publish' AND p.post_type IN ('product','product_variation')
            AND ($match $suggested) ORDER BY ($match) DESC, p.post_title, p.ID LIMIT 101");
        if ($wpdb->last_error) { return API::error('search_unavailable', 'ค้นหาสินค้าไม่ได้ กรุณาลองอีกครั้ง', 503); }
        $used = [];
        foreach ($draft['rows'] as $row) {
            if ($row['row'] !== $rowNumber && isset($row['id']) && empty($draft['removed'][$row['row']])) {
                $used[$row['id']] ??= $row['row'];
            }
        }
        $items = [];
        foreach ($ids as $id) {
            $id = (int)$id;
            if (!Policy::accessible($id,true)) { continue; }
            $product = wc_get_product($id);
            if (!$product || !$product->is_type(['simple','variation']) || Policy::fieldReasons($product,'sale_price')) { continue; }
            $items[] = ['id'=>$id,'name'=>$product->get_name(),'price'=>$product->get_price('edit'),
                'variation'=>$product->is_type('variation') ? wc_get_formatted_variation($product,true,true) : '',
                'used_row'=>$used[$id] ?? null];
            if (count($items) >= 12) { break; }
        }
        return ['items'=>$items,'limited'=>count($ids) >= 101 || count($items) >= 12];
    }

    public static function importSelect(string $batch, mixed $input): array|\WP_Error {
        $draft = self::importDraft($batch);
        if (is_wp_error($draft)) { return $draft; }
        if (!is_array($input) || !is_int($input['row'] ?? null)) {
            return API::error('invalid_selection', 'เลือกรายการใหม่อีกครั้ง', 400);
        }
        $action = $input['action'] ?? 'select';
        $replace = $input['replace_row'] ?? null;
        if (!in_array($action,['select','remove','restore','edit','update'],true)
            || ($action === 'select' && (!is_int($input['product_id'] ?? null) || $input['product_id'] < 1
                || ($replace !== null && (!is_int($replace) || $replace === $input['row']))))) {
            return API::error('invalid_selection', 'เลือกรายการใหม่อีกครั้ง', 400);
        }
        $lock = self::lock('operation:'.$batch);
        if (!$lock) { return API::error('lock_timeout', 'ชุดนี้กำลังถูกตรวจ กรุณาลองอีกครั้ง', 409); }
        try {
            $status = self::importStatus($batch);
            if (is_wp_error($status)) { return $status; }
            if ($status['status'] !== 'ready') { return API::error('import_completed','ชุดนี้เริ่มบันทึกแล้ว กรุณาตรวจผล',409); }
            $draft = self::importDraft($batch);
            if (is_wp_error($draft)) { return $draft; }
            if (isset($input['revision']) && $input['revision'] !== $draft['revision']) {
                return API::error('review_required','รายการเปลี่ยนไป กรุณาตรวจผลล่าสุด',409);
            }
            $number = $input['row'];
            $index = array_search($number,array_column($draft['rows'],'row'),true);
            if ($action === 'update') {
                $updated = self::updateImportRow($draft,$number,$input['values'] ?? null);
                if (is_wp_error($updated)) { return $updated; }
                $draft = $updated;
            } elseif ($action === 'edit') {
                $edited = self::editImportIssue($draft,$number,$input['values'] ?? null);
                if (is_wp_error($edited)) { return $edited; }
                $draft = $edited;
            } elseif ($index === false) {
                return API::error('invalid_selection','ไม่พบแถวที่เลือก',404);
            } elseif ($action === 'remove') {
                $draft['removed'][$number] = true;
            } elseif ($action === 'restore') {
                $removal = $draft['removed'][$number] ?? null;
                if (is_array($removal)) {
                    $changedIndex = array_search($removal['before']['row'],array_column($draft['rows'],'row'),true);
                    if ($changedIndex !== false && $draft['rows'][$changedIndex] === $removal['after']) {
                        $draft['rows'][$changedIndex] = $removal['before'];
                    }
                }
                unset($draft['removed'][$number]);
            } else {
                $row = $draft['rows'][$index];
                if (!empty($draft['removed'][$number])) { return API::error('review_required','คืนแถวนี้ก่อนเลือกสินค้า',409); }
                if (empty($row['permanent']) && $row['start'] <= time()) { return API::error('preview_changed','เวลาเริ่มผ่านแล้ว กรุณาแก้ไฟล์',409); }
                $replaced = false;
                foreach ($draft['rows'] as $other) {
                    $otherNumber = $other['row'];
                    if ($otherNumber === $number || !empty($draft['removed'][$otherNumber])
                        || ($other['id'] ?? null) !== $input['product_id']) { continue; }
                    if ($otherNumber !== $replace) {
                        return API::error('duplicate_product','แถว '.$number.' กับแถว '.$otherNumber.' เป็นสินค้าเดียวกัน',409);
                    }
                    $replaced = true;
                }
                if ($replace !== null && !$replaced) { return API::error('review_required','แถวที่ซ้ำเปลี่ยนไป กรุณาตรวจผลล่าสุด',409); }
                $selected = self::bindImportRow($row,$input['product_id'],'manual');
                if (is_wp_error($selected)) { return $selected; }
                $draft['rows'][$index] = $selected;
                if ($replaced) { $draft['removed'][$replace] = ['before'=>$row,'after'=>$selected]; }
            }
            $draft['revision']++;
            $remaining = $draft['expires'] - time();
            if ($remaining <= 0) { return API::error('preview_expired','ผลตรวจหมดอายุ กรุณาอัปโหลดใหม่',404); }
            if (!set_transient('sdd_promo_csv_'.$batch,$draft,$remaining)) {
                return API::error('preview_unavailable','ยังบันทึกการเปลี่ยนแปลงไม่ได้ กรุณาลองอีกครั้ง',503);
            }
            return self::importReview($batch,$draft);
        } finally { self::unlock([$lock]); }
    }

    private static function updateImportRow(array $draft, int $number, mixed $values): array|\WP_Error {
        $index = array_search($number,array_column($draft['rows'],'row'),true);
        if ($index === false || !empty($draft['removed'][$number]) || !is_array($values)) {
            return API::error('invalid_selection','ไม่พบรายการที่แก้ไขได้',400);
        }
        $original = $draft['rows'][$index];
        if (!isset($original['id']) || isset($original['message'])) {
            return API::error('review_required','เลือกสินค้าให้ครบก่อนแก้ไขราคา',409);
        }
        $allowed = !empty($original['permanent']) ? ['price'] : ['price','from','until'];
        if (array_diff($allowed,array_keys($values)) || array_diff(array_keys($values),$allowed)) {
            return API::error('invalid_selection','กรอกราคาและวันเวลาให้ครบ',400);
        }
        foreach ($values as $value) {
            if (!is_string($value) || strlen($value)>100 || preg_match('/[\r\n]/',$value)) {
                return API::error('invalid_selection','กรอกข้อมูลในรูปแบบที่ระบุ',400);
            }
        }
        if ((string)get_post_field('post_title',$original['id'],'raw') !== $original['name']) {
            return API::error('review_required','ชื่อสินค้าเปลี่ยนไป กรุณาตรวจผลล่าสุด',409);
        }
        $fields = [$original['input'],$values['price'],$values['from'] ?? '',$values['until'] ?? ''];
        $parsed = self::importRow($fields,$number,$original['input'],$draft['mode'] ?? 'temporary',$original['id'],$original['method']);
        if (is_wp_error($parsed)) { return $parsed; }
        // The user's chosen product remains authoritative even when the file uses an alias.
        $updated = self::bindImportRow($parsed,$original['id'],$original['method']);
        if (is_wp_error($updated)) { return $updated; }
        $draft['rows'][$index] = $updated;
        return $draft;
    }

    private static function importIssue(int $number, array $fields, \WP_Error $error): array {
        $issue = ['row'=>$number,'name'=>trim((string)$fields[0]),'message'=>$error->get_error_message()];
        if (in_array($error->get_error_code(),['invalid_price','invalid_dates'],true)) {
            $issue['edit'] = $error->get_error_data()['field'] ?? 'price';
            $issue['values'] = array_combine(['price','from','until'],array_map(
                static fn($value) => mb_substr(trim((string)$value),0,100),array_slice($fields,1)
            ));
        }
        return $issue;
    }

    private static function editImportIssue(array $draft, int $number, mixed $values): array|\WP_Error {
        $index = array_search($number,array_column($draft['errors'],'row'),true);
        if ($index === false || !isset($draft['errors'][$index]['edit']) || !is_array($values)) {
            return API::error('invalid_selection','ไม่พบแถวราคาและวันที่ที่แก้ได้',400);
        }
        $issue = $draft['errors'][$index];
        $allowed = $issue['edit'] === 'price' ? ['price'] : ['from','until'];
        if (array_diff($allowed,array_keys($values)) || array_diff(array_keys($values),$allowed)) {
            return API::error('invalid_selection','กรอกข้อมูลให้ครบก่อนตรวจ',400);
        }
        foreach ($values as $value) {
            if (!is_string($value) || strlen($value) > 100 || preg_match('/[\r\n]/',$value)) {
                return API::error('invalid_selection','กรอกข้อมูลในรูปแบบที่ระบุ',400);
            }
        }
        $updated = array_replace($issue['values'],$values);
        $fields = [$issue['name'],$updated['price'],$updated['from'],$updated['until']];
        $row = self::importRow($fields,$number,$issue['name'],$draft['mode'] ?? 'temporary');
        if (is_wp_error($row)) {
            $draft['errors'][$index] = self::importIssue($number,$fields,$row);
        } else {
            array_splice($draft['errors'],$index,1);
            $draft['rows'][] = $row;
            usort($draft['rows'],static fn($a,$b) => $a['row'] <=> $b['row']);
        }
        return $draft;
    }

    public static function importPreview(\WP_REST_Request $request): array|\WP_Error {
        if (!self::canImport()) { return API::error('forbidden', 'ไม่มีสิทธิ์นำเข้าโปร', 403); }
        if (!Schema::ready()) { return API::error('schema_unavailable', 'ระบบตั้งโปรยังไม่พร้อม', 503); }
        $file = $request->get_file_params()['file'] ?? [];
        if (($file['error'] ?? null) !== UPLOAD_ERR_OK || !is_string($file['tmp_name'] ?? null)
            || !is_uploaded_file($file['tmp_name']) || ($file['size'] ?? 0) > 262144) {
            return API::error('invalid_csv', 'เลือกไฟล์ CSV ขนาดไม่เกิน 256 KB', 400);
        }
        $content = file_get_contents($file['tmp_name'], false, null, 0, 262145);
        if (!is_string($content) || strlen($content) > 262144 || !preg_match('//u', $content) || str_contains($content, "\0")) {
            return API::error('invalid_csv', 'บันทึกไฟล์เป็น CSV UTF-8 แล้วลองอีกครั้ง', 400);
        }
        $mode = $request->get_body_params()['mode'] ?? 'temporary';
        if (!in_array($mode,['temporary','permanent'],true)) { return API::error('invalid_mode','เลือกประเภทโปรอีกครั้ง',400); }
        return self::previewCsv($content,$mode);
    }

    private static function previewCsv(string $content, string $mode = 'temporary'): array|\WP_Error {
        // One physical line per record. Quoted cells may contain commas or doubled quotes.
        $cell = '(?:"(?:[^"]|"")*"|[^",]*)';
        $record = '/^'.$cell.'(?:,'.$cell.')'.($mode === 'permanent' ? '{1}' : '{3}').'$/D';
        $lines = preg_split('/\r\n|\n|\r/', preg_replace('/^\xEF\xBB\xBF/', '', $content));
        $header = array_shift($lines);
        $permanent = $mode === 'permanent';
        $columns = $permanent ? ['product_name','sale_price'] : ['product_name','sale_price','starts_at','ends_at'];
        if (str_getcsv($header, ',', '"', '') !== $columns) {
            return API::error('invalid_header', 'หัวตารางต้องเป็น '.implode(', ',$columns).' ตามลำดับ', 400);
        }
        $rows = []; $errors = []; $count = 0;
        foreach ($lines as $index => $line) {
            if (trim($line) === '') { continue; }
            if (++$count > 100) { return API::error('too_many_rows', 'ไฟล์หนึ่งชุดใส่ได้ไม่เกิน 100 รายการ', 400); }
            $number = $index + 2;
            if (!preg_match($record, $line)) {
                $errors[] = ['row'=>$number,'name'=>'','message'=>'แถวนี้ต้องมี '.count($columns).' ช่อง ตรวจจุลภาคและเครื่องหมายคำพูดในไฟล์'];
                continue;
            }
            $fields = array_pad(str_getcsv($line, ',', '"', ''),4,'');
            $name = trim((string)($fields[0] ?? ''));
            $row = self::importRow($fields, $number, $name,$mode);
            if (is_wp_error($row)) {
                $errors[] = self::importIssue($number,$fields,$row);
                continue;
            }
            $rows[] = $row;
        }
        if (!$count) { return API::error('empty_csv', 'เพิ่มสินค้าอย่างน้อย 1 รายการในไฟล์', 400); }
        $batch = wp_generate_uuid4();
        $draft = ['actor'=>get_current_user_id(),'timezone'=>wp_timezone_string(),'expires'=>time()+900,
            'revision'=>1,'mode'=>$mode,'total'=>$count,'rows'=>$rows,'errors'=>$errors];
        if (!set_transient('sdd_promo_csv_'.$batch,$draft,900)) {
            return API::error('preview_unavailable','ยังเก็บผลตรวจไม่ได้ กรุณาตรวจไฟล์อีกครั้ง',503);
        }
        return self::importReview($batch,$draft);
    }

    private static function importRow(array $fields, int $number, string $name, string $mode, ?int $chosenId = null, ?string $chosenMethod = null): array|\WP_Error {
        if (count($fields) !== 4 || $name === '' || strlen($name) > 1024 || preg_match('/[\r\n]/', implode('', $fields))) {
            return API::error('invalid_row', 'กรอกชื่อสินค้า ราคา วันเริ่ม และวันจบให้ครบในแถวเดียว', 400);
        }
        [, $price, $from, $until] = array_map('trim', $fields);
        if (!Policy::integer($price) || (int)$price < 1) {
            return API::error('invalid_price', 'ใส่ราคาโปรเป็นจำนวนเต็มบาทที่มากกว่า 0', 400);
        }
        $permanent = $mode === 'permanent';
        $start = $end = 0;
        if (!$permanent) {
            $start = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/D', $from) ? self::parseTime(str_replace(' ', 'T', $from)) : null;
            $end = preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/D', $until) ? self::parseTime(str_replace(' ', 'T', $until)) : null;
            if ($start === null || $start <= time()) {
                return API::error('invalid_dates',$start === null ? 'กรอกวันเริ่มเป็น YYYY-MM-DD HH:mm' : 'เวลาเริ่มผ่านไปแล้ว เลือกเวลาในอนาคต',400,['field'=>'from']);
            }
            if ($end === null || $end <= $start) {
                return API::error('invalid_dates',$end === null ? 'กรอกวันจบเป็น YYYY-MM-DD HH:mm' : 'วันจบต้องอยู่หลังวันเริ่ม',400,['field'=>'until']);
            }
        }
        $row = ['row'=>$number,'permanent'=>$permanent,'input'=>$name,'price'=>$price,'start'=>$start,'end'=>$end,'from'=>$from,'until'=>$until];
        $matches = $chosenId === null ? self::nameMatches($name) : [$chosenId];
        $method = $chosenMethod ?? 'exact';
        if (!$matches) { $matches = self::modelMatches($name); $method = 'model'; }
        if (count($matches) !== 1) {
            return $row + ['message'=>$matches ? 'พบหลายรายการ กรุณาเลือกสินค้าที่ต้องการ' : 'ยังไม่พบสินค้า กรุณาค้นหาและเลือกสินค้า'];
        }
        $selected = self::bindImportRow($row,$matches[0],$method);
        if (is_wp_error($selected) && ($selected->get_error_data()['field'] ?? null) === 'price') {
            return API::error('invalid_price',$selected->get_error_message(),400,['field'=>'price']);
        }
        return is_wp_error($selected) ? $row + ['message'=>$selected->get_error_message()] : $selected;
    }

    private static function bindImportRow(array $row, int $id, string $method): array|\WP_Error {
        $base = self::validatePlan($id,$row['price'],$row['start'],$row['end'],null,false);
        if (is_wp_error($base)) { return $base; }
        $name = (string)get_post_field('post_title',$id,'raw');
        [$originalStart,$originalEnd] = explode('|', $base['sale_dates']);
        $end = $row['end'];
        $originalSaleAtEnd = self::hasOriginalSale($base) && ($originalStart === '' || (int)$originalStart <= $end)
            && ($originalEnd === '' || (int)$originalEnd >= $end);
        unset($row['message']);
        $revisions = [];
        if (!empty($row['permanent'])) {
            foreach (array_keys($base) as $field) { $revisions[$field] = Writer::revision($id,$field); }
        }
        return array_replace($row,['id'=>$id,'name'=>$name,'method'=>$method,'base'=>$base,'revisions'=>$revisions,
            'current_price'=>get_post_meta($id,'_price',true), 'before'=>self::reference($base,$row['start'])['price'],'after'=>$originalSaleAtEnd ? $base['sale_price'] : $base['regular_price']]);
    }

    /** Use the normal audited Writer for each product, with durable IDs for safe retries. */
    private static function continuePermanent(string $batch, array $manifest): array|\WP_Error {
        global $wpdb;
        $table = Schema::table('operations');
        $started = microtime(true);
        $handled = 0;
        foreach ($manifest['rows'] as $index=>$row) {
            if (isset($manifest['results'][$index])) { continue; }
            if ($handled >= 5 || microtime(true)-$started >= 6) { break; }
            $handled++;
            $saved = Writer::salePlan($row['id'],[
                'operation_id'=>$row['operation'],'price'=>$row['price'],'dates'=>'|',
                'baseline'=>$row['base'],'base_revisions'=>$row['revisions'],'confirmed'=>true,
            ], static function () use ($row) {
                $valid = self::validatePlan($row['id'],$row['price'],time(),time(),$row['base'],false);
                return is_wp_error($valid) ? $valid : true;
            });
            if (is_wp_error($saved) && in_array($saved->get_error_code(),['operation_unknown','lock_timeout','nested_write'],true)) {
                return $saved;
            }
            $manifest['results'][$index] = ['row'=>$row['row'],'name'=>$row['name'],'ok'=>!is_wp_error($saved),
                'message'=>is_wp_error($saved) ? $saved->get_error_message() : ''];
            $status = count($manifest['results']) === count($manifest['rows']) ? 'completed' : 'running';
            if ($wpdb->update($table,['preview_json'=>wp_json_encode($manifest),'status'=>$status,'updated_at'=>gmdate('Y-m-d H:i:s')],['operation_id'=>$batch]) !== 1) {
                return API::error('operation_unknown','ตรวจผลชุดเดิมก่อนทำต่อ',409);
            }
        }
        return self::permanentResult($manifest);
    }

    private static function permanentResult(array $manifest): array {
        $success = array_filter($manifest['results'],static fn($row) => $row['ok']);
        $total = count($manifest['rows']);
        return ['mode'=>'permanent','status'=>count($manifest['results']) === $total ? 'completed' : 'running',
            'revision'=>$manifest['revision'],'count'=>count($success),'total'=>$total,'processed'=>count($manifest['results']),
            'errors'=>array_values(array_filter($manifest['results'],static fn($row) => !$row['ok']))];
    }

    private static function permanentManifest(string $batch): array|\WP_Error|null {
        global $wpdb;
        $raw = $wpdb->get_var($wpdb->prepare('SELECT preview_json FROM '.Schema::table('operations').
            " WHERE operation_id=%s AND actor_id=%d AND kind='permanent_csv'", $batch,get_current_user_id()));
        if ($wpdb->last_error) { return API::error('status_unavailable','ยังอ่านผลไม่ได้ กรุณาตรวจผลอีกครั้ง',503); }
        return is_string($raw) ? json_decode($raw,true,512,JSON_THROW_ON_ERROR) : null;
    }

    public static function importStatus(string $batch): array|\WP_Error {
        if (!self::canImport()) { return API::error('forbidden', 'ไม่มีสิทธิ์นำเข้าโปร', 403); }
        if (!self::uuid($batch) || !Schema::ready()) { return API::error('invalid_batch', 'ไม่พบชุดนำเข้า', 404); }
        $manifest = self::permanentManifest($batch);
        if (is_wp_error($manifest)) { return $manifest; }
        if ($manifest !== null) { return self::permanentResult($manifest); }
        global $wpdb;
        $result = $wpdb->get_var($wpdb->prepare('SELECT preview_json FROM '.Schema::table('operations').
            " WHERE operation_id=%s AND actor_id=%d AND kind='temporary_csv' AND status='completed'", $batch, get_current_user_id()));
        if ($wpdb->last_error) { return API::error('status_unavailable', 'ยังอ่านผลไม่ได้ กรุณาตรวจผลอีกครั้ง', 503); }
        if (is_string($result)) { return ['status'=>'completed'] + json_decode($result,true); }
        $draft = self::importDraft($batch);
        return is_wp_error($draft) ? $draft : ['status'=>'ready'] + self::importReview($batch,$draft);
    }

    /** Cancel only an uncommitted draft, using the same lock as confirmation. */
    public static function importCancel(string $batch): array|\WP_Error {
        if (!self::canImport()) { return API::error('forbidden', 'ไม่มีสิทธิ์นำเข้าโปร', 403); }
        if (!self::uuid($batch) || !Schema::ready()) { return API::error('invalid_batch', 'ไม่พบชุดนำเข้า', 404); }
        $lock = self::lock('operation:'.$batch);
        if (!$lock) { return API::error('lock_timeout','ชุดนี้กำลังดำเนินการ กรุณาตรวจผลก่อนยกเลิก',409); }
        try {
            $status = self::importStatus($batch);
            if (is_wp_error($status)) { return $status; }
            if ($status['status'] !== 'ready') {
                return API::error('import_started','ชุดนี้เริ่มบันทึกแล้ว ยกเลิกการนำเข้าจากหน้านี้ไม่ได้ กรุณาตรวจผลคำสั่งเดิม',409);
            }
            if (!delete_transient('sdd_promo_csv_'.$batch) && get_transient('sdd_promo_csv_'.$batch) !== false) {
                return API::error('cancel_unavailable','ยังยกเลิกไม่ได้ กรุณาลองอีกครั้ง',503);
            }
            return ['status'=>'cancelled'];
        } finally { self::unlock([$lock]); }
    }

    public static function importConfirm(string $batch, mixed $revision = null): array|\WP_Error {
        if (!self::canImport()) { return API::error('forbidden', 'ไม่มีสิทธิ์นำเข้าโปร', 403); }
        if (!self::uuid($batch) || !Schema::ready()) { return API::error('invalid_batch', 'ไม่พบชุดนำเข้า', 404); }
        global $wpdb;
        $lock = self::lock('operation:'.$batch);
        if (!$lock) { return API::error('lock_timeout', 'กำลังบันทึกชุดนี้ กรุณาตรวจผลอีกครั้ง', 409); }
        $locks = [$lock]; $transaction = false; $plans = [];
        try {
            $manifest = self::permanentManifest($batch);
            if (is_wp_error($manifest)) { return $manifest; }
            if ($manifest !== null) {
                if ($revision !== $manifest['revision']) { return API::error('review_required','ตรวจผลล่าสุดก่อนทำต่อ',409); }
                return self::continuePermanent($batch,$manifest);
            }
            $status = self::importStatus($batch);
            if (is_wp_error($status) || $status['status'] === 'completed') { return $status; }
            $preview = self::importDraft($batch);
            if (is_wp_error($preview)) { return $preview; }
            if ($revision !== $preview['revision'] || $status['errors'] || !$status['rows']) {
                return API::error('review_required','ตรวจผลล่าสุดและแก้รายการที่มีปัญหาก่อนยืนยัน',409);
            }
            $activeRows = array_filter($preview['rows'], static fn($row) => empty($preview['removed'][$row['row']]));
            $ids = [];
            foreach ($activeRows as $row) {
                $ids[] = $row['id'];
                if ($parent = (int)get_post_field('post_parent', $row['id'])) { $ids[] = $parent; }
            }
            sort($ids, SORT_NUMERIC);
            foreach (array_unique($ids) as $id) {
                $lock = self::lock('product:'.$id);
                if (!$lock) { return API::error('lock_timeout', 'สินค้ากำลังถูกแก้ไข กรุณาตรวจผลก่อนลองอีกครั้ง', 409); }
                $locks[] = $lock;
            }
            foreach ($activeRows as $row) {
                $base = self::validatePlan($row['id'],$row['price'],$row['start'],$row['end'],$row['base'],false);
                $sameProduct = (string)get_post_field('post_title',$row['id'],'raw') === $row['name'];
                if ($row['method'] === 'exact') { $sameProduct = $sameProduct && self::nameMatches($row['input']) === [$row['id']]; }
                if ($row['method'] === 'model') {
                    $sameProduct = $sameProduct && !self::nameMatches($row['input']) && self::modelMatches($row['input']) === [$row['id']];
                }
                if ((empty($row['permanent']) && $row['start'] <= time()) || !$sameProduct || is_wp_error($base)) {
                    return API::error('preview_changed', 'แถว '.$row['row'].' · '.$row['name'].' · '.(is_wp_error($base) ? $base->get_error_message() : 'ชื่อสินค้าหรือเวลาเริ่มเปลี่ยนไป').' กรุณาตรวจไฟล์อีกครั้ง', 409);
                }
            }
            if (($preview['mode'] ?? 'temporary') === 'permanent') {
                $rows = array_values($activeRows);
                foreach ($rows as &$row) { $row['operation'] = wp_generate_uuid4(); }
                unset($row);
                $manifest = ['revision'=>$preview['revision'],'rows'=>$rows,'results'=>[]];
                $now = gmdate('Y-m-d H:i:s');
                if ($wpdb->insert(Schema::table('operations'),['operation_id'=>$batch,'actor_id'=>get_current_user_id(),
                    'kind'=>'permanent_csv','payload_hash'=>hash('sha256',wp_json_encode($preview)),
                    'preview_json'=>wp_json_encode($manifest),'status'=>'running','created_at'=>$now,'updated_at'=>$now]) !== 1) {
                    return API::error('operation_unknown','ตรวจผลชุดเดิมก่อนทำต่อ',409);
                }
                // The shared Writer owns each product lock. Keep only the batch lock.
                self::unlock(array_slice($locks,1));
                $locks = [$lock];
                return self::continuePermanent($batch,$manifest);
            }
            if ($wpdb->query('START TRANSACTION') === false) { throw new \RuntimeException('Transaction failed.'); }
            $transaction = true;
            foreach ($activeRows as $row) {
                $op = wp_generate_uuid4();
                $hash = hash('sha256', wp_json_encode([get_current_user_id(),$row['id'],$row['price'],$row['start'],$row['end'],$row['base']]));
                [$plans[]] = self::insertPlan($row['id'],$op,$hash,$row['price'],$row['start'],$row['end'],$row['base'],false);
            }
            $result = ['count'=>count($plans),'first_start'=>min(array_column($plans,'starts_at'))];
            if ($result['first_start'] <= time()) {
                return API::error('preview_changed', 'ถึงเวลาเริ่มของบางรายการแล้ว กรุณาแก้เวลาและตรวจไฟล์อีกครั้ง', 409);
            }
            $now = gmdate('Y-m-d H:i:s');
            if ($wpdb->insert(Schema::table('operations'), ['operation_id'=>$batch,'actor_id'=>get_current_user_id(),
                'kind'=>'temporary_csv','payload_hash'=>hash('sha256',wp_json_encode($preview)), 'preview_json'=>wp_json_encode($result),
                'status'=>'completed','created_at'=>$now,'updated_at'=>$now]) !== 1 || $wpdb->query('COMMIT') === false) {
                throw new \RuntimeException('Batch commit failed.');
            }
            $transaction = false;
        } catch (\Throwable) {
            API::log('writer_failure');
            return API::error('operation_unknown', 'กรุณาตรวจผลการตั้งโปรก่อนส่งใหม่', 409);
        } finally {
            if ($transaction) { $wpdb->query('ROLLBACK'); }
            self::unlock($locks);
        }
        delete_transient('sdd_promo_csv_'.$batch);
        try {
            foreach ($plans as $plan) { self::schedule($plan); }
        } catch (\Throwable) { API::log('writer_failure'); }

        return ['status'=>'completed'] + $result;
    }

    private static function schedule(array $r): void {
        if (!in_array($r['status'], ['pending','active'], true)) { return; }
        self::scheduleScan();
        foreach (['starts_at','ends_at'] as $key) {
            // Phase arguments keep start/end events distinct even when less than ten minutes apart.
            if ((int)$r[$key] > time()) { wp_schedule_single_event((int)$r[$key], 'sdd_temporary_sale_tick', [$r['id'], $key]); }
        }
    }
    public static function scan(): void {
        if (!Schema::ready()) { return; } global $wpdb;
        $ids = $wpdb->get_col($wpdb->prepare('SELECT id FROM ' . self::table() . " WHERE (status='pending' AND starts_at<=%d) OR (status='active' AND ends_at<=%d) ORDER BY ends_at ASC LIMIT 20", time(),time()));
        foreach ($ids as $id) { self::tick($id); }
        if (!self::hasLive()) { wp_clear_scheduled_hook('sdd_temporary_sale_scan'); }
    }
    public static function tick(string $id, string $phase = ''): void { self::process($id, false); }
    public static function cancel(int $productId, string $id, mixed $in): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !Policy::accessible($productId, true)) { return API::error('forbidden', 'ไม่มีสิทธิ์ปิดโปร', 403); }
        if (!Schema::ready() || !is_array($in) || array_keys($in) !== ['confirmed'] || $in['confirmed'] !== true) { return API::error('invalid_input', 'ต้องยืนยันปิดรายการโปร', 400); }
        $r = self::row($id); if (!$r || (int)$r['product_id'] !== $productId) { return API::error('not_found','ไม่พบโปรสินค้านี้',404); }
        return self::process($id, true);
    }
    private static function process(string $id, bool $cancel): array|\WP_Error {
        if (!Schema::ready()) { return API::error('schema_unavailable','Schema ไม่พร้อม',503); }
        $lock = self::lock('promotion:'.$id); if (!$lock) { return API::error('lock_timeout','กำลังประมวลผลโปร',503); }
        $beforeActor = get_current_user_id();
        try {
            $r = self::row($id); if (!$r) { return API::error('not_found','ไม่พบโปร',404); }
            if (!in_array($r['status'],['pending','active','needs_review'],true)) { return ['ok'=>true,'promotion'=>self::publicRow($r)]; }
            if ($cancel && $r['status'] !== 'active') { self::update($id,['status'=>'cancelled','message'=>$r['status']==='needs_review'?'ปิดรายการตรวจสอบแล้ว คงราคาปัจจุบัน':'ยกเลิกก่อนเริ่ม']); return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))]; }
            if ($r['status'] === 'needs_review') { return API::error('needs_review',$r['message'],409); }
            if (!$cancel && (($r['status']==='pending' && (int)$r['starts_at']>time()) || ($r['status']==='active' && (int)$r['ends_at']>time()))) { return ['ok'=>true,'promotion'=>self::publicRow($r)]; }
            if ($r['status']==='pending' && (int)$r['ends_at']<=time()) { self::update($id,['status'=>'needs_review','message'=>'เลยเวลาจบก่อนเริ่ม ไม่เปลี่ยนราคา กรุณาตรวจสอบและปิดรายการ']); return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))]; }
            if ($reasons=Policy::globalReasons()) { self::update($id,['message'=>implode('; ',$reasons).' — รอประมวลผล รวมถึงการคืนราคา']); return API::error('write_unavailable',implode('; ',$reasons),503); }
            wp_set_current_user((int)$r['actor_id']);
            $pid=(int)$r['product_id'];
            if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_edit_products') || !current_user_can('sdd_view_products') || !Policy::accessible($pid,true)) { self::update($id,['status'=>'needs_review','message'=>'ผู้สร้างโปรไม่มีสิทธิ์แก้สินค้าแล้ว หยุดอัตโนมัติ']); return API::error('needs_review','สิทธิ์ผู้สร้างโปรเปลี่ยน ต้องตรวจสอบ',409); }
            $storedExpected=json_decode($r['expected_json'],true); $expected=array_intersect_key($storedExpected,array_flip(['regular_price','sale_price','sale_dates'])); $original=json_decode($r['original_json'],true); $starting=$r['status']==='pending';
            $nativeEnded=$original; $nativeEnded['sale_price']=''; $nativeEnded['sale_dates']='|';
            if ($starting && $expected!==$original && $expected!==$nativeEnded) { self::update($id,['status'=>'needs_review','message'=>'ข้อมูลราคาเดิมเปลี่ยน ต้องตรวจสอบก่อนเริ่ม']); return API::error('needs_review','ข้อมูลราคาเดิมเปลี่ยน ต้องตรวจสอบ',409); }
            $reference=$starting?self::reference($original,time())['price']:($storedExpected['_reference_price']??self::reference($original,(int)$r['starts_at'])['price']);
            if ($starting && (int)$r['sale_price'] >= (int)$reference) { self::update($id,['status'=>'needs_review','message'=>'ราคาโปรชั่วคราวไม่ต่ำกว่าราคาที่มีผลก่อนเริ่ม ต้องตรวจสอบ']); return API::error('needs_review','ราคาอ้างอิงเปลี่ยน ต้องตรวจสอบ',409); }
            $effective = Writer::fresh($pid);
            if (!$starting && (!$effective || $effective->get_price('edit') !== $expected['sale_price'])) { self::update($id,['status'=>'needs_review','message'=>'ราคาที่แสดงเปลี่ยนจากโปรชั่วคราว หยุดคืนอัตโนมัติ']); return API::error('needs_review','ราคาที่แสดงเปลี่ยน ต้องตรวจสอบ',409); }
            $target=$starting?['sale_price'=>$r['sale_price'],'sale_dates'=>'|']:array_intersect_key($original,array_flip(['sale_price','sale_dates']));
            $originalEnd=explode('|',$original['sale_dates'])[1];
            $revived=!$starting && ($storedExpected['_revive_expired']??false) && self::hasOriginalSale($original) && $originalEnd!=='' && (int)$originalEnd<=time();
            // A stored zero original sale means no original promotion; clear it on restoration.
            if (!$starting && !self::hasOriginalSale($original)) { $target=['sale_price'=>'','sale_dates'=>'|']; }
            if ($revived) { $target['sale_dates']='|'; }
            $op=$starting?$r['start_operation']:$r['end_operation'];
            $input=['operation_id'=>$op,'field'=>'sale_price','base_value'=>$expected['sale_price'],'base_revision'=>Writer::revision($pid,'sale_price'),'value'=>$target['sale_price'],'acknowledgements'=>['price_change','zero_price','expired_schedule']];
            // Exclude hooks for this product only; other product changes still trigger review.
            self::$ownProduct=$pid;
            $result=Writer::transition($pid,$input,['expected'=>$expected,'target'=>$target,'promotion'=>$id,'source'=>$starting?'temporary_start':'temporary_restore',
                'guard'=>static fn()=> (self::row($id)['status']??'')===$r['status'] && (!$starting || self::reference($original,time())['price']===$reference),
                'record'=>static function($values)use($id,$starting,$cancel,$r,$reference,$storedExpected,$revived){ self::updateState($id,$r['status'],['status'=>$starting?'active':($cancel?'cancelled':'restored'),'expected_json'=>wp_json_encode(array_merge(array_intersect_key($values,array_flip(['regular_price','sale_price','sale_dates'])),['_reference_price'=>$reference,'_revive_expired'=>(bool)($storedExpected['_revive_expired']??false)])),'message'=>$starting?'โปรชั่วคราวกำลังใช้':($revived?'คืนราคาโปรเดิมและล้างวันหมดอายุแล้ว':($cancel?'ยุติโปรและคืนตารางเดิมแล้ว':'คืนราคาและตารางโปรเดิมแล้ว'))]); }
            ]);
            if (is_wp_error($result)) { self::update($id,['status'=>'needs_review','message'=>'หยุดอัตโนมัติ: '.$result->get_error_code().' กรุณาตรวจราคาและ audit ก่อนปิดรายการ']); return $result; }
            return ['ok'=>true,'promotion'=>self::publicRow(self::row($id))];
        } catch (\Throwable $e) { API::log('writer_failure'); return API::error('operation_unknown','ไม่ยืนยันผลโปร ต้องตรวจสอบก่อนทำต่อ',409); }
        finally { self::$ownProduct=0; wp_set_current_user($beforeActor); self::unlock([$lock]); }
    }
}
