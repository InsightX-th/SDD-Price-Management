<?php
declare(strict_types=1);
namespace SDD;
/** Read-only storefront presentation; never changes checkout prices or snapshots. */
final class Storefront {
    private static array $shown = [];
    private static array $plans = [];
    public static function boot(): void {
        // Theme setup registers its legacy shortcode/hooks after plugins_loaded.
        add_action('init', [self::class, 'integrate'], 30);
        add_filter('woocommerce_get_price_html', [self::class, 'priceHtml'], 30, 2);
        add_filter('woocommerce_available_variation', [self::class, 'variation'], 30, 3);
        add_action('wp_enqueue_scripts', [self::class, 'assets']);
        add_action('woocommerce_after_product_object_save', static function ($p): void { unset(self::$plans[$p->get_id()]); }, 100);
    }
    public static function integrate(): void {
        remove_action('woocommerce_after_shop_loop_item', 'display_sale_end_date_in_shop', 15);
        add_shortcode('sale_end_date', [self::class, 'shortcode']);
        add_action('woocommerce_before_shop_loop_item', [self::class, 'reset']);
        add_action('woocommerce_before_single_product', [self::class, 'reset']);
        add_action('woocommerce_after_shop_loop_item_title', [self::class, 'output'], 12);
        add_action('woocommerce_single_product_summary', [self::class, 'output'], 11);
        add_action('woocommerce_after_template_part', [self::class, 'afterTemplate'], 10, 4);
    }
    public static function reset(): void { self::$shown = []; self::$plans = []; }
    public static function assets(): void {
        wp_enqueue_style('sdd-storefront', plugins_url('assets/storefront.css', SDD_FILE), [], SDD_VERSION);
        if (is_product()) { wp_enqueue_script('sdd-storefront', plugins_url('assets/storefront.js', SDD_FILE), ['jquery','wc-add-to-cart-variation'], SDD_VERSION, true); }
    }
    /** Only return a running, consistent plan; an old snapshot must not label a manually changed price. */
    public static function active(\WC_Product $p): ?array {
        if (get_option('sdd_schema_version') !== Schema::VERSION || !in_array($p->get_type(), ['simple','variation'], true)) { return null; }
        global $wpdb;
        if (!array_key_exists($p->get_id(), self::$plans)) { self::$plans[$p->get_id()] = $wpdb->get_row($wpdb->prepare('SELECT * FROM '.Schema::table('temporary_sales')." WHERE product_id=%d AND status='active' ORDER BY created_at DESC LIMIT 1", $p->get_id()), ARRAY_A); }
        $row = self::$plans[$p->get_id()];
        if (!$row || (int)$row['starts_at'] > time() || (int)$row['ends_at'] <= time()) { return null; }
        $expected = array_intersect_key(json_decode($row['expected_json'], true), array_flip(['regular_price','sale_price','sale_dates']));
        if ($expected !== TemporarySales::snapshot($p) || $p->get_price('edit') !== $row['sale_price'] || $p->get_price() !== $row['sale_price']) { return null; }
        return $row;
    }
    public static function period(\WC_Product $p): ?array {
        if ($p->is_type('variable')) {
            $period = null; $label = null;
            foreach ($p->get_visible_children() as $id) {
                $child = wc_get_product($id);
                if (!$child || !$child->is_purchasable()) { continue; }
                $next = self::period($child);
                if ($next === null) { return null; }
                $nextLabel = self::periodLabel($next);
                if ($label !== null && $label !== $nextLabel) { return null; }
                $period = $next; $label = $nextLabel;
            }
            return $period;
        }
        if ($plan = self::active($p)) { return [(int)$plan['starts_at'], (int)$plan['ends_at']]; }
        if (!$p->is_on_sale()) { return null; }
        $from = $p->get_date_on_sale_from('edit'); $to = $p->get_date_on_sale_to('edit');
        return $to && $to->getTimestamp() > time() && (!$from || $from->getTimestamp() <= time()) ? [$from ? $from->getTimestamp() : null, $to->getTimestamp()] : null;
    }
    private static function periodLabel(array $period): string {
        return 'วันนี้ - '.wp_date('d/m/Y', $period[1], wp_timezone());
    }
    public static function end(\WC_Product $p): ?int { return self::period($p)[1] ?? null; }
    public static function dateHtml(\WC_Product $p): string {
        $period = self::period($p);
        return $period === null ? '' : '<p class="sale-end-date">'.esc_html(self::periodLabel($period)).'</p>';
    }
    /** Flatsome UX Builder calls the price template without the standard summary action. */
    public static function afterTemplate($name, $path = '', $located = '', $args = []): void {
        if ($name === 'single-product/price.php' && is_product()) { self::output(); }
    }
    public static function shortcode(): string {
        global $product;
        $p = $product instanceof \WC_Product ? $product : wc_get_product(get_the_ID());
        if (!$p) { return ''; }
        $key = (string)$p->get_id();
        if (isset(self::$shown[$key])) { return ''; }
        $html = self::dateHtml($p);
        // Keep a replaceable empty slot for variable products with different schedules.
        if ($p->is_type('variable') && is_product() && (int)get_queried_object_id() === $p->get_id()) {
            $html = '<div class="sdd-sale-date-slot" data-sdd-product="'.esc_attr($key).'">'.$html.'</div>';
        }
        if ($html !== '') { self::$shown[$key] = true; }
        return $html;
    }
    public static function output(): void { echo self::shortcode(); }
    public static function priceHtml(string $html, \WC_Product $p): string {
        if ($p->is_type('variable')) {
            $oldPrices = []; $newPrices = [];
            foreach ($p->get_visible_children() as $id) {
                $child = wc_get_product($id);
                if (!$child || !$child->is_purchasable()) { continue; }
                $running = self::active($child);
                if (!$running) { return $html; }
                $base = json_decode($running['original_json'], true);
                $reference = json_decode($running['expected_json'], true)['_reference_price'] ?? TemporarySales::reference($base, (int)$running['starts_at'])['price'];
                $old = wc_get_price_to_display($child, ['price' => $reference]);
                $current = wc_get_price_to_display($child, ['price' => $running['sale_price']]);
                if ($old <= $current) { return $html; }
                $oldPrices[] = $old; $newPrices[] = $current;
            }
            if (!$oldPrices) { return $html; }
            $range = static fn(array $prices): string => min($prices) === max($prices) ? wc_price(min($prices)) : wc_format_price_range(min($prices), max($prices));
            return wc_format_sale_price($range($oldPrices), $range($newPrices)).$p->get_price_suffix();
        }
        $plan = self::active($p);
        if (!$plan) { return $html; }
        $original = json_decode($plan['original_json'], true);
        $reference = json_decode($plan['expected_json'], true)['_reference_price'] ?? TemporarySales::reference($original, (int)$plan['starts_at'])['price'];
        $old = wc_get_price_to_display($p, ['price' => $reference]);
        $current = wc_get_price_to_display($p, ['price' => $plan['sale_price']]);
        // A higher temporary price must not be presented as a discount.
        if ($old <= $current) { return wc_price($current).$p->get_price_suffix(); }
        return wc_format_sale_price($old, $current).$p->get_price_suffix();
    }
    public static function variation(array $data, \WC_Product $parent, \WC_Product_Variation $child): array {
        $data['sdd_sale_end_html'] = self::dateHtml($child);
        // WooCommerce may omit price_html for same-priced choices; each temporary reference can differ.
        if (self::active($child)) { $data['price_html'] = '<span class="price">'.$child->get_price_html().'</span>'; }
        return $data;
    }
}
