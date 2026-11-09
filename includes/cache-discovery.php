<?php
declare(strict_types=1);
namespace SDD;

/** Conservative inventory: explicit product lists are scoped, dynamic displays remain shared. */
final class CacheDiscovery {
    private const KEY = 'sdd_cache_page_inventory_v2';
    public static function boot(): void {
        add_action('save_post', [self::class, 'invalidate']);
        add_action('deleted_post', [self::class, 'invalidate']);
        add_action('set_object_terms', [self::class, 'invalidate']);
        foreach (['added_post_meta','updated_post_meta','deleted_post_meta'] as $hook) {
            add_action($hook, static function ($id, $post, $key): void {
                if ($key === '_elementor_data') { self::invalidate(); }
            }, 10, 3);
        }
    }
    public static function invalidate(int $postId = 0): void {
        if ($postId && in_array(get_post_type($postId), ['product','product_variation','attachment'], true)) { return; }
        delete_transient(self::KEY);
    }
    /** No rendering or HTTP: shortcodes may have side effects and pages may be cached. */
    public static function containsProducts(string $content): bool {
        return (bool)preg_match('~\[(?:ux_products(?:_list)?|products|product|product_page|product_category|product_categories|sale_products|featured_products|recent_products|best_selling_products|top_rated_products|related_products|add_to_cart|ux_block|block)\b|<!--\s*wp:(?:woocommerce/[^\s>]*product[^\s>]*|core/block|block)\b|"widgetType"\s*:\s*"[^"]*product~i', $content);
    }
    /** Scope only unambiguous WooCommerce lists. Builders and dynamic queries remain shared. */
    private static function fixedProducts(string $content, string $builder): array {
        if (self::containsProducts($builder)) { return []; }
        $ids = [];
        $remaining = preg_replace_callback('~\[(products|product_page)\s+((?:ids|id)\s*=\s*["\'][0-9,\s]+["\'])\s*\]~i', static function ($match) use (&$ids) {
            $attrs = shortcode_parse_atts($match[2]);
            $key = strtolower($match[1]) === 'products' ? 'ids' : 'id';
            if (!isset($attrs[$key])) { return $match[0]; }
            foreach (preg_split('/[\s,]+/', trim($attrs[$key]), -1, PREG_SPLIT_NO_EMPTY) as $value) {
                $id = (int)$value;
                if ($id > 0) { $ids[$id] = $id; }
            }
            return '';
        }, $content);
        return self::containsProducts($remaining ?? $content) ? [] : array_values($ids);
    }
    public static function inventory(): array {
        $cached = get_transient(self::KEY);
        if (is_array($cached)) { return $cached; }
        global $wpdb;
        $types = array_values(array_diff(get_post_types(['public'=>true]), ['product','product_variation','attachment']));
        $items = []; $cursor = 0;
        if (!$types) { return []; }
        $marks = implode(',', array_fill(0, count($types), '%s'));
        do {
            $rows = $wpdb->get_results($wpdb->prepare("SELECT ID,post_title,post_content FROM $wpdb->posts WHERE ID>%d AND post_status='publish' AND post_password='' AND post_type IN ($marks) ORDER BY ID LIMIT 200", $cursor, ...$types), ARRAY_A);
            if ($wpdb->last_error) { throw new \RuntimeException('cache_discovery_unavailable'); }
            foreach ($rows as $row) {
                $cursor = (int)$row['ID'];
                $elementor = get_post_meta($cursor, '_elementor_data', true);
                $builder = is_string($elementor) ? $elementor : '';
                if (!self::containsProducts($row['post_content']) && !self::containsProducts($builder)) { continue; }
                $items[] = ['id'=>$cursor, 'title'=>wp_strip_all_tags($row['post_title']), 'products'=>self::fixedProducts($row['post_content'], $builder)];
            }
        } while (count($rows) === 200);
        set_transient(self::KEY, $items, HOUR_IN_SECONDS);
        return $items;
    }
    public static function urls(bool $dry, int $product = 0, int $parent = 0): array {
        $urls = [];
        foreach (self::inventory() as $item) {
            if ($product && $item['products'] && !array_intersect([$product,$parent], $item['products'])) { continue; }
            // Recheck visibility even when an older inventory is being used.
            $post = get_post($item['id']);
            if (!$post || $post->post_status !== 'publish' || $post->post_password !== '') { continue; }
            $url = get_permalink($post);
            if (is_string($url) && CacheURLs::allowed($url, $dry)) { $urls[$url] = ['url'=>$url,'title'=>$item['title']]; }
        }
        return array_values($urls);
    }
}
