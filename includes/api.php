<?php
declare(strict_types=1);
namespace SDD;
final class API {
    private static ?string $requestId = null;
    public static function requestId(): string { return self::$requestId ??= wp_generate_uuid4(); }
    public static function error(string $code, string $message, int $status, array $data = []): \WP_Error { return new \WP_Error($code, $message, ['status' => $status, 'request_id' => self::requestId()] + $data); }
    public static function log(string $code): void {
        if (!in_array($code, ['writer_failure','schema_failure','publication_failure','external_observation_failure','external_reduction_failure'], true) || !function_exists('wc_get_logger')) { return; }
        if (class_exists(SystemLogs::class) && !SystemLogs::claimLogEmission()) { return; }
        // WC logger owns rotation/storage. Limit this adapter's error emission to 10/minute (soft).
        $key = 'sdd_log_' . gmdate('YmdHi'); $n = (int) get_transient($key);
        if ($n >= 10) { return; } set_transient($key, $n+1, 120);
        try { wc_get_logger()->error($code, ['source' => 'sdd-stock-price', 'request_id' => self::requestId()]); } catch (\Throwable $e) { /* Technical logger cannot turn a committed write into a failure. */ }
    }
    public static function permission(\WP_REST_Request $r, string $cap = 'sdd_view_products'): true|\WP_Error {
        // Cookie identity must agree with WordPress's authenticated user; reject JWT/application passwords.
        $cookie = wp_validate_auth_cookie('', 'logged_in');
        if (!$cookie || (int) $cookie !== get_current_user_id()) { return self::error('cookie_required', 'กรุณาเข้าสู่ระบบ WordPress', 401); }
        if (!wp_verify_nonce($r->get_header('X-WP-Nonce'), 'wp_rest')) { return self::error('rest_cookie_invalid_nonce', 'กรุณาเข้าสู่ระบบอีกครั้งหรือโหลด nonce ใหม่', 403); }
        if (!current_user_can($cap)) { return self::error('forbidden', 'สิทธิ์ไม่เพียงพอ', 403); }
        if (strlen((string) $r->get_body()) > 262144) { return self::error('body_too_large', 'คำขอมีขนาดใหญ่เกินไป', 413); }
        $write = $r->get_method() !== 'GET'; $key = 'sdd_rate_' . get_current_user_id() . '_' . ($write ? 'w' : 'r') . '_' . gmdate('YmdHi');
        $n = (int) get_transient($key); if ($n >= 120) { return self::error('rate_limited', 'คำขอถี่เกินไป กรุณารอหนึ่งนาที', 429, ['retry_after' => 60]); }
        set_transient($key, $n+1, 120); return true;
    }
    public static function register(): void {
        $routes = [
            ['/health', 'GET', static fn($r) => Inspection::health($r->get_query_params()), 'sdd_manage_settings'],
            ['/audit', 'GET', static fn($r) => Inspection::audit($r->get_query_params()), 'sdd_view_audit'],
            ['/logs', 'GET', static fn($r) => SystemLogs::listing($r->get_query_params()), 'sdd_view_system_logs'],
            ['/logs/(?P<id>[a-z0-9_.-]{1,120})', 'GET', static fn($r) => SystemLogs::read($r->get_url_params()['id']), 'sdd_view_system_logs'],
            ['/events', 'GET', static fn($r) => Feed::changes($r->get_query_params()), 'sdd_view_products'],
            ['/bulk/preview', 'POST', static fn($r) => is_wp_error($rate=Bulk::rate())?$rate:Bulk::preview($r->get_json_params()), 'sdd_bulk_edit'],
            ['/operations/(?P<id>[a-f0-9-]{36})/execute', 'POST', static fn($r) => is_wp_error($rate=Bulk::rate())?$rate:Bulk::execute($r->get_url_params()['id'],$r->get_json_params()), 'sdd_edit_products'],
            ['/events/(?P<id>[1-9][0-9]{0,17})/rollback-preview', 'POST', static fn($r) => is_wp_error($rate=Bulk::rate())?$rate:Bulk::rollbackPreview($r->get_url_params()['id'],$r->get_json_params()), 'sdd_rollback'],
            ['/products/(?P<id>[1-9][0-9]{0,17})', 'GET', static fn($r) => Catalog::product((int)$r->get_url_params()['id']), 'sdd_view_products'],
            ['/products', 'GET', static fn($r) => Catalog::products($r->get_query_params()), 'sdd_view_products'],
            ['/workspace-sync', 'POST', static fn($r) => WorkspaceSync::read($r->get_json_params()), 'sdd_view_products'],
            ['/promotion-articles', 'GET', static fn() => Catalog::promotionArticles(), 'sdd_view_products'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/variations', 'GET', static fn($r) => Catalog::variations((int)$r->get_url_params()['id'], $r->get_query_params()), 'sdd_view_products'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/sale-plan', 'POST', static fn($r) => Writer::salePlan((int)$r->get_url_params()['id'], $r->get_json_params()), 'sdd_edit_products'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/temporary-sales', 'GET', static fn($r) => TemporarySales::listing((int)$r->get_url_params()['id']), 'sdd_manage_settings'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/temporary-sales', 'POST', static fn($r) => TemporarySales::create((int)$r->get_url_params()['id'], $r->get_json_params()), 'sdd_manage_settings'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/temporary-sales/(?P<promotion>[a-f0-9-]{36})/cancel', 'POST', static fn($r) => TemporarySales::cancel((int)$r->get_url_params()['id'], $r->get_url_params()['promotion'], $r->get_json_params()), 'sdd_manage_settings'],
            ['/brands', 'GET', static fn($r) => self::terms('product_tag', 1, true), 'sdd_view_products'],
            ['/categories', 'GET', static fn($r) => self::terms('product_cat', (int) ($r['page'] ?? 1), false), 'sdd_view_products'],
            ['/brand-terms', 'GET', static fn($r) => self::terms('product_tag', (int) ($r['page'] ?? 1), false), 'sdd_manage_settings'],
            ['/settings', 'GET', static fn() => self::settingsResponse(), 'sdd_manage_settings'],
            ['/settings', 'POST', [self::class, 'saveSettings'], 'sdd_manage_settings'],
            ['/session', 'GET', static fn() => ['ok' => true, 'nonce' => wp_create_nonce('wp_rest')], 'sdd_view_products'],
            ['/products/(?P<id>[1-9][0-9]{0,17})/field', 'POST', static function ($r) { $input = self::writeInput($r->get_json_params()); return is_wp_error($input) ? $input : Writer::execute((int) $r->get_url_params()['id'], $input); }, 'sdd_edit_products'],
            ['/operations/(?P<id>[a-f0-9-]{36})', 'GET', [self::class, 'operation'], 'sdd_view_products'],
        ];
        foreach ($routes as [$path, $method, $handler, $cap]) {
            register_rest_route('sdd/v1', $path, ['methods' => $method, 'callback' => $handler, 'permission_callback' => static fn($r) => self::permission($r, $cap)]);
        }
        add_filter('rest_post_dispatch', static function ($response, $server, $request) {
            if (str_starts_with($request->get_route(), '/sdd/v1/')) {
                $response = rest_ensure_response($response); $response->header('Cache-Control', 'private, no-store, max-age=0'); $response->header('Vary', 'Cookie'); $response->header('X-Content-Type-Options', 'nosniff');
            } return $response;
        }, 10, 3);
        add_filter('rest_pre_serve_request', static function ($served, $result, $request) {
            if (str_starts_with($request->get_route(), '/sdd/v1/')) { header_remove('Access-Control-Allow-Origin'); header_remove('Access-Control-Allow-Credentials'); }
            return $served;
        }, 20, 3);
    }
    public static function writeInput(mixed $in): array|\WP_Error {
        $bad = static fn() => self::error('invalid_input', 'รูปแบบคำสั่งไม่ถูกต้อง', 400);
        if (!is_array($in) || array_diff(array_keys($in), ['operation_id','field','value','base_value','base_revision','acknowledgements'])) { return $bad(); }
        foreach (['operation_id','field','value','base_value','base_revision'] as $k) { if (!isset($in[$k]) || !is_string($in[$k])) { return $bad(); } }
        if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/D', $in['operation_id']) || !in_array($in['field'], Policy::FIELDS, true) || !preg_match('/^(0|[1-9][0-9]{0,17})$/D', $in['base_revision']) || strlen($in['value']) > 64 || strlen($in['base_value']) > 64) { return $bad(); }
        $acks = $in['acknowledgements'] ?? [];
        if (!is_array($acks) || !array_is_list($acks) || count($acks)>3 || count(array_filter($acks, 'is_string')) !== count($acks) || array_diff($acks, ['zero_price','price_change','expired_schedule','schedule_change'])) { return $bad(); }
        $in['acknowledgements'] = array_values(array_unique($acks)); return $in;
    }
    public static function terms(string $taxonomy, int $page, bool $allowed): array|\WP_Error {
        if ($page < 1 || $page > 10000) { return self::error('invalid_page', 'หน้าไม่ถูกต้อง', 400); }
        $ids = Policy::settings()['brand_ids'] ?? [];
        if ($allowed && !$ids) { return ['items' => [], 'pages' => 0]; }
        $args = ['taxonomy' => $taxonomy, 'hide_empty' => false, 'number' => 100, 'offset' => ($page-1)*100, 'orderby' => 'name'];
        if ($allowed) { $args['include'] = $ids; $args['number'] = 500; }
        $terms = get_terms($args); if (is_wp_error($terms)) { return self::error('terms_unavailable', 'โหลดรายการไม่ได้', 503); }
        $total = $allowed ? count($terms) : (int) wp_count_terms(['taxonomy' => $taxonomy, 'hide_empty' => false]);
        return ['items' => array_map(static fn($t) => ['id' => (string) $t->term_id, 'name' => html_entity_decode($t->name, ENT_QUOTES | ENT_HTML5, 'UTF-8')], $terms), 'pages' => (int) ceil($total/100)];
    }
    public static function settingsResponse(): array { return ['settings' => Policy::settings(), 'schema_ready' => Schema::ready(), 'currency' => get_woocommerce_currency(), 'prices_include_tax' => wc_prices_include_tax(), 'php' => PHP_VERSION, 'version' => SDD_VERSION]; }
    public static function saveSettings(\WP_REST_Request $r): array|\WP_Error {
        $in = $r->get_json_params();
        if (!is_array($in) || array_diff(array_keys($in), ['brand_ids','write_stop','local_ack']) || !isset($in['brand_ids'],$in['write_stop'],$in['local_ack']) || !is_array($in['brand_ids']) || !array_is_list($in['brand_ids']) || count($in['brand_ids']) > 500 || !is_bool($in['write_stop']) || !is_bool($in['local_ack'])) { return self::error('invalid_settings', 'ข้อมูลตั้งค่าไม่ถูกต้อง', 400); }
        $ids = [];
        foreach ($in['brand_ids'] as $id) {
            if (!is_string($id) || !preg_match('/^[1-9][0-9]{0,17}$/D', $id) || !term_exists((int) $id, 'product_tag')) { return self::error('invalid_brand', 'ไม่พบแท็กแบรนด์ที่เลือก', 400); }
            $ids[] = (int) $id;
        }
        $in['brand_ids'] = array_values(array_unique($ids)); $in['confirmation_mode'] = 'always';
        if (!$in['write_stop']) {
            $blockers = Policy::enableReasons(true);
            if (!$in['local_ack'] || $blockers) { return self::error('write_unavailable', 'ยังไม่ผ่านเงื่อนไขเปิดการแก้ไขสินค้า', 503, ['blockers' => $blockers, 'confirmation_required' => !$in['local_ack']]); }
        }
        update_option('sdd_settings', $in, false); return self::settingsResponse();
    }
    public static function operation(\WP_REST_Request $r): array|\WP_Error {
        global $wpdb;
        if (!Schema::ready()) { return self::error('schema_unavailable', 'Schema ไม่พร้อม', 503); }
        $operationId = $r->get_url_params()['id'] ?? $r['id'];
        if (Bulk::isBatch($operationId)) { return Bulk::status($operationId); }
        $row = $wpdb->get_row($wpdb->prepare('SELECT o.actor_id,i.product_id,i.status,i.canonical_result_json FROM ' . Schema::table('operations') . ' o JOIN ' . Schema::table('operation_items') . ' i ON o.operation_id=i.operation_id WHERE o.operation_id=%s', $operationId), ARRAY_A);
        if (!$row || (int) $row['actor_id'] !== get_current_user_id() || !Policy::accessible((int) $row['product_id'])) { return self::error('not_found', 'ไม่พบคำสั่งที่มีสิทธิ์ดู', 404); }
        return ['operation_id' => $operationId, 'status' => $row['canonical_result_json'] ? $row['status'] : 'unknown', 'result' => $row['canonical_result_json'] ? json_decode($row['canonical_result_json'], true) : null];
    }
}
