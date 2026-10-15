<?php
declare(strict_types=1);
namespace SDD;
final class Admin {
    public static function url(): string { return admin_url('admin.php?page=sdd-stock-price'); }
    public static function shortcut(\WP_Admin_Bar $bar): void {
        if (!current_user_can('sdd_view_products')) { return; }
        $bar->add_node(['id' => 'sdd-stock-price', 'title' => __('สต็อก & ราคา ↗', 'sdd-stock-price'), 'href' => self::url(), 'meta' => ['target' => '_blank', 'rel' => 'noopener noreferrer', 'title' => __('เปิด SoundDD ในแท็บใหม่', 'sdd-stock-price')]]);
    }
    public static function boot(): void {
        add_action('admin_init', static function():void {
            Schema::upgradeRoleCapabilities();
            if (current_user_can('manage_options') && get_option('sdd_p3_caps')!=='1') {
                $role=get_role('administrator');if ($role) { $role->add_cap('sdd_bulk_edit');$role->add_cap('sdd_rollback');update_option('sdd_p3_caps','1',false);wp_get_current_user()->get_role_caps(); }
            }
        });
        add_action('admin_bar_menu', [self::class, 'shortcut'], 80);
        $navigation = static function (): void {
            if (current_user_can('sdd_view_products')) { wp_enqueue_script('sdd-navigation', plugins_url('assets/navigation.js', SDD_FILE), [], SDD_VERSION, true); }
        };
        add_action('admin_enqueue_scripts', $navigation);
        add_action('wp_enqueue_scripts', static function () use ($navigation): void { if (is_admin_bar_showing()) { $navigation(); } });
        add_filter('plugin_action_links_' . plugin_basename(SDD_FILE), static function (array $links): array {
            if (current_user_can('sdd_view_products')) { array_unshift($links, '<a href="' . esc_url(self::url()) . '" target="_blank" rel="noopener noreferrer">' . esc_html__('เปิดสต็อก & ราคา ↗', 'sdd-stock-price') . '</a>'); }
            return $links;
        });
        add_action('admin_menu', static function (): void {
            add_menu_page(__('สต็อก & ราคา', 'sdd-stock-price'), __('สต็อก & ราคา', 'sdd-stock-price'), 'sdd_view_products', 'sdd-stock-price', [self::class, 'page'], 'dashicons-tag', 56);
        });
        add_action('admin_enqueue_scripts', static function ($hook): void {
            if ($hook !== 'toplevel_page_sdd-stock-price') { return; }
            wp_enqueue_style('sdd-stock-price', plugins_url('assets/app.css', SDD_FILE), [], SDD_VERSION);
            wp_enqueue_script('sdd-stock-price', plugins_url('assets/app.js', SDD_FILE), ['wp-element'], SDD_VERSION, true);
            $config = ['api' => esc_url_raw(rest_url('sdd/v1/')), 'ajax' => admin_url('admin-ajax.php'), 'nonce' => wp_create_nonce('wp_rest'), 'login' => wp_login_url(admin_url('admin.php?page=sdd-stock-price')), 'back' => admin_url(), 'user' => wp_get_current_user()->display_name, 'currency' => get_woocommerce_currency(), 'canBulk' => current_user_can('sdd_bulk_edit'), 'canRollback' => current_user_can('sdd_rollback'), 'canSettings' => current_user_can('sdd_manage_settings'), 'canAudit' => current_user_can('sdd_view_audit'), 'canLogs' => current_user_can('sdd_view_system_logs'), 'version' => SDD_VERSION, 'timezone' => wp_timezone_string()];
            wp_add_inline_script('sdd-stock-price', 'window.SDD_CONFIG=' . wp_json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) . ';', 'before');
        });
        // Cookie-authenticated same-origin nonce refresh. No unauthenticated AJAX action is registered.
        add_action('wp_ajax_sdd_session', static function (): void {
            nocache_headers();
            if (!current_user_can('sdd_view_products')) { wp_send_json_error(['message' => 'สิทธิ์ไม่เพียงพอ'], 403); }
            wp_send_json_success(['nonce' => wp_create_nonce('wp_rest')]);
        });
        add_action('admin_notices', static function (): void {
            if (current_user_can('sdd_manage_settings') && !Schema::ready()) { echo '<div class="notice notice-error"><p>' . esc_html__('SoundDD schema ไม่พร้อม: หยุดการเขียน กรุณาตรวจแล้วเปิดใช้ปลั๊กอินใหม่', 'sdd-stock-price') . '</p></div>'; }
        });
    }
    public static function page(): void {
        if (!current_user_can('sdd_view_products')) { wp_die(esc_html__('สิทธิ์ไม่เพียงพอ', 'sdd-stock-price')); }
        nocache_headers();
        echo '<div id="sdd-root"><p>' . esc_html__('กำลังโหลด SoundDD…', 'sdd-stock-price') . '</p></div>';
    }
}
