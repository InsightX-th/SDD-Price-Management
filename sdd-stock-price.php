<?php
/**
 * Plugin Name: SoundDD Stock & Price
 * Description: Production-bound store product editor; this release is for Local testing.
 * Version: 0.5.21
 * Requires at least: 6.8
 * Requires PHP: 8.2
 * Requires Plugins: woocommerce
 * WC requires at least: 10.0
 * Text Domain: sdd-stock-price
 */
declare(strict_types=1);
namespace SDD;
if (!defined('ABSPATH')) { exit; }
define('SDD_FILE', __FILE__);
define('SDD_VERSION', '0.5.21');
foreach (['schema', 'policy', 'writer', 'bulk', 'catalog', 'feed', 'external-changes', 'workspace-sync', 'temporary-sales', 'storefront', 'inspection', 'system-logs', 'retention', 'api', 'admin'] as $module) { require_once __DIR__ . '/includes/' . $module . '.php'; }
register_activation_hook(__FILE__, [Schema::class, 'activate']);
register_deactivation_hook(__FILE__, static function (): void { wp_clear_scheduled_hook('sdd_feed_publish');wp_clear_scheduled_hook('sdd_external_drain');wp_clear_scheduled_hook('sdd_log_retention');wp_clear_scheduled_hook('sdd_business_retention'); });
add_action('plugins_loaded', static function (): void {
    if (!class_exists('WooCommerce') || version_compare(PHP_VERSION, '8.2', '<')) {
        add_action('admin_notices', static function (): void { echo '<div class="notice notice-error"><p>' . esc_html__('SoundDD ต้องใช้ WooCommerce และ PHP 8.2 ขึ้นไป', 'sdd-stock-price') . '</p></div>'; });
        return;
    }
    Admin::boot();
    SystemLogs::boot();
    Retention::boot();
    TemporarySales::boot();
    Feed::boot();
    ExternalChanges::boot();
    Storefront::boot();
    add_action('rest_api_init', [API::class, 'register']);
});
