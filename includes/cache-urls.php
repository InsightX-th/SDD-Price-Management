<?php
declare(strict_types=1);
namespace SDD;

/** Finite, persisted URL inventory; enumeration is incremental, never silently truncated. */
final class CacheURLs {
    public static function allowed(string $url, bool $dry = false): bool {
        $u = wp_parse_url($url); $home = wp_parse_url(home_url('/'));
        if (!$u || !$home || !isset($u['host']) || strtolower($u['host']) !== strtolower($home['host'] ?? '') || isset($u['user']) || isset($u['pass']) || isset($u['fragment'])) { return false; }
        if (($u['scheme'] ?? '') !== 'https' && !($dry && ($u['scheme'] ?? '') === 'http')) { return false; }
        if (($u['port'] ?? null) !== ($home['port'] ?? null)) { return false; }
        $path = rawurldecode($u['path'] ?? '/');
        if (str_contains($path, '..') || str_contains($path, '\\') || preg_match('/[\x00-\x1f\x7f]/', $url)) { return false; }
        foreach (['/wp-admin','/wp-json','/wp-login.php'] as $private) { if (str_contains($path, $private)) { return false; } }
        foreach (['cart','checkout','myaccount'] as $page) {
            $private = wc_get_page_permalink($page);
            $privatePath = is_string($private) ? wp_parse_url($private, PHP_URL_PATH) : null;
            if ($privatePath && $privatePath !== '/' && str_starts_with(rtrim($path,'/') . '/', rtrim($privatePath,'/') . '/')) { return false; }
        }
        parse_str($u['query'] ?? '', $query);
        foreach (['rest_route','wc-ajax','add-to-cart','preview','preview_id','_wpnonce','sdd_view','sdd_product'] as $key) { if (array_key_exists($key,$query)) { return false; } }
        // Never accept cart/account pages via plain-permalink page_id either.
        if (isset($query['page_id']) && in_array((int)$query['page_id'], array_map('wc_get_page_id',['cart','checkout','myaccount']), true)) { return false; }
        return strlen($url) <= 2048;
    }
    public static function validPayload(array $file, bool $dry): bool {
        if (array_diff(array_keys($file), ['url','headers','kind']) || !is_string($file['url'] ?? null) || !self::allowed($file['url'], $dry)) { return false; }
        if (isset($file['kind']) && ($file['kind']!=='prefix'||!self::prefixable($file['url']))) { return false; }
        $headers = $file['headers'] ?? [];
        return is_array($headers) && !array_diff(array_keys($headers), ['CF-Device-Type']) && (!isset($headers['CF-Device-Type']) || in_array($headers['CF-Device-Type'], ['desktop','mobile','tablet'], true));
    }
    public static function prefixable(string $url): bool {
        $u=wp_parse_url($url);
        // Root prefixes would invalidate the whole site; plain query permalinks need exact URLs.
        return !empty($u['path']) && $u['path']!=='/' && !isset($u['query']) && str_ends_with($u['path'],'/');
    }
    public static function snapshot(\WC_Product $p, array $settings): array {
        $parent = $p->is_type('variation') ? $p->get_parent_id() : $p->get_id();
        $product = get_permalink($parent); $entries = [];
        if (!is_string($product) || !self::allowed($product, $settings['dry_run'])) { throw new \RuntimeException('cache_mapping'); }
        $entries[$product] = ['url'=>$product,'pages'=>1];
        $pages = max(1,(int)(wp_count_posts('product')->publish ?? 0)); // Safe upper bound for legacy query-based archives.
        $shop = wc_get_page_permalink('shop');
        if ($shop && wc_get_page_id('shop') > 0) { $entries[$shop] = ['url'=>$shop,'pages'=>$pages]; }
        foreach (['product_cat','product_tag'] as $taxonomy) {
            $terms = wp_get_object_terms($parent, $taxonomy, ['fields'=>'ids']);
            if (is_wp_error($terms)) { throw new \RuntimeException('cache_mapping'); }
            $ids = $terms;
            if ($taxonomy === 'product_cat') { foreach ($terms as $term) { $ids = array_merge($ids,get_ancestors((int)$term,$taxonomy,'taxonomy')); } }
            foreach (array_unique($ids) as $id) {
                $url = get_term_link((int)$id,$taxonomy);
                if (is_wp_error($url)) { throw new \RuntimeException('cache_mapping'); }
                $entries[$url] = ['url'=>$url,'pages'=>$pages];
            }
        }
        $entries[home_url('/')] ??= ['url'=>home_url('/'),'pages'=>1];
        foreach (CacheDiscovery::urls($settings['dry_run'], $p->get_id(), $parent) as $page) { $entries[$page['url']] ??= ['url'=>$page['url'],'pages'=>1]; }
        foreach ($settings['extra_urls'] as $url) { $entries[$url] ??= ['url'=>$url,'pages'=>1]; }
        foreach ($entries as $entry) { if (!self::allowed($entry['url'],$settings['dry_run'])) { throw new \RuntimeException('cache_mapping'); } }
        foreach ($entries as &$entry) { if (self::prefixable($entry['url'])) { $entry['kind']='prefix'; $entry['pages']=1; } } unset($entry);
        return ['entries'=>array_values($entries),'devices'=>['','desktop','mobile','tablet'],'zone'=>CloudflareClient::zone(),'home'=>home_url('/'),'pagination_base'=>$GLOBALS['wp_rewrite']->pagination_base ?? 'page','pretty'=>(bool)get_option('permalink_structure')];
    }
    /** Flat cursor across archive pages and device variants; returns at most $limit targets. */
    public static function batch(array $snapshot, int $cursor, int $limit = 100): array {
        if (!isset($snapshot['entries'],$snapshot['devices']) || !is_array($snapshot['entries']) || !is_array($snapshot['devices'])) { throw new \RuntimeException('cache_snapshot'); }
        $variants = $snapshot['devices'] ?: ['']; $total = 0; $items = [];
        foreach ($snapshot['entries'] as $entry) {
            $pages = (int)$entry['pages'];
            if ($pages < 1 || $pages > 10000) { throw new \RuntimeException('mapping_too_large'); }
            $entryVariants=($entry['kind']??'')==='prefix'?['']:$variants;
            $length = $pages * count($entryVariants);
            if ($total + $length <= $cursor) { $total += $length; continue; }
            for ($index=max(0,$cursor-$total); $index<$length && count($items)<$limit; $index++) {
                $page = intdiv($index,count($entryVariants))+1; $device = $entryVariants[$index % count($entryVariants)]; $url = $entry['url'];
                if ($page > 1) {
                    $url = !empty($snapshot['pretty']) && !str_contains($url,'?')
                        ? trailingslashit($url) . user_trailingslashit($snapshot['pagination_base'] . '/' . $page,'paged')
                        : add_query_arg('paged',$page,$url);
                }
                $file = ['url'=>$url]; if (($entry['kind']??'')==='prefix') { $file['kind']='prefix'; } if ($device !== '') { $file['headers'] = ['CF-Device-Type'=>$device]; }
                $items[] = $file;
            }
            $total += $length;
            if (count($items) >= $limit) { break; }
        }
        $next = $cursor + count($items);
        // The final partial batch detects exhaustion on this call; exact-full batches do one cheap extra pass.
        return ['items'=>$items,'cursor'=>$next,'done'=>count($items)<$limit];
    }
}
