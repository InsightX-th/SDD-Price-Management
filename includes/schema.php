<?php
declare(strict_types=1);
namespace SDD;
final class Schema {
    public const VERSION = '5';
    public static function table(string $name): string {
        global $wpdb;
        if (!in_array($name, ['events', 'field_state', 'operations', 'operation_items', 'temporary_sales', 'publications', 'feed_state', 'external_observations'], true)) { throw new \InvalidArgumentException('Table identifier.'); }
        return $wpdb->prefix . 'sdd_' . $name;
    }
    public static function definitions(): array {
        global $wpdb;
        $cc = $wpdb->get_charset_collate();
        $uuid = 'char(36) CHARACTER SET ascii COLLATE ascii_bin';
        $common = " ENGINE=InnoDB $cc;";
        return [
            'external_observations' => 'CREATE TABLE ' . self::table('external_observations') . " (
 id bigint unsigned NOT NULL AUTO_INCREMENT,
 product_id bigint unsigned NOT NULL,
 field varchar(20) NOT NULL,
 old_value varchar(64) NOT NULL,
 new_value varchar(64) NOT NULL,
 source varchar(32) NOT NULL,
 request_id $uuid NOT NULL,
 created_at datetime NOT NULL,
 event_id bigint unsigned DEFAULT NULL,
 PRIMARY KEY  (id),
 UNIQUE KEY linked_event (event_id),
 KEY product_pending (product_id,event_id,id),
 KEY pending (event_id,id)
)" . $common,
            'feed_state' => 'CREATE TABLE ' . self::table('feed_state') . " (
 id bigint unsigned NOT NULL,
 sequence bigint unsigned NOT NULL DEFAULT 0,
 PRIMARY KEY  (id)
)" . $common,
            'publications' => 'CREATE TABLE ' . self::table('publications') . " (
 sequence bigint unsigned NOT NULL,
 event_id bigint unsigned NOT NULL,
 published_at datetime NOT NULL,
 PRIMARY KEY  (sequence),
 UNIQUE KEY event_identity (event_id)
)" . $common,
            'temporary_sales' => 'CREATE TABLE ' . self::table('temporary_sales') . " (
 id $uuid NOT NULL,
 product_id bigint unsigned NOT NULL,
 actor_id bigint unsigned NOT NULL,
 payload_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 status varchar(32) NOT NULL,
 starts_at bigint NOT NULL,
 ends_at bigint NOT NULL,
 sale_price varchar(64) NOT NULL,
 original_json longtext NOT NULL,
 expected_json longtext NOT NULL,
 start_operation $uuid NOT NULL,
 end_operation $uuid NOT NULL,
 message varchar(255) NOT NULL DEFAULT '',
 created_at datetime NOT NULL,
 updated_at datetime NOT NULL,
 PRIMARY KEY  (id),
 KEY product_state (product_id,status),
 KEY due (status,starts_at,ends_at)
)" . $common,
            'events' => 'CREATE TABLE ' . self::table('events') . " (
 id bigint unsigned NOT NULL AUTO_INCREMENT,
 product_id bigint unsigned NOT NULL,
 field varchar(20) NOT NULL,
 old_value varchar(64) NOT NULL,
 new_value varchar(64) NOT NULL,
 revision_before bigint unsigned NOT NULL,
 revision_after bigint unsigned NOT NULL,
 source varchar(32) NOT NULL,
 user_id bigint unsigned DEFAULT NULL,
 operation_id $uuid DEFAULT NULL,
 item_id $uuid DEFAULT NULL,
 request_id $uuid NOT NULL,
 reverts_event_id bigint unsigned DEFAULT NULL,
 created_at datetime NOT NULL,
 PRIMARY KEY  (id),
 UNIQUE KEY item_field (item_id,field),
 KEY product_field (product_id,field,id),
 KEY product_history (product_id,id),
 KEY created (created_at,id)
)" . $common,
            'field_state' => 'CREATE TABLE ' . self::table('field_state') . " (
 product_id bigint unsigned NOT NULL,
 field varchar(20) NOT NULL,
 revision bigint unsigned NOT NULL DEFAULT 0,
 last_known_value varchar(64) NOT NULL,
 last_event_id bigint unsigned DEFAULT NULL,
 updated_at datetime NOT NULL,
 PRIMARY KEY  (product_id,field)
)" . $common,
            'operations' => 'CREATE TABLE ' . self::table('operations') . " (
 operation_id $uuid NOT NULL,
 actor_id bigint unsigned NOT NULL,
 kind varchar(20) NOT NULL,
 payload_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 preview_json longtext DEFAULT NULL,
 status varchar(32) NOT NULL,
 expires_at datetime DEFAULT NULL,
 created_at datetime NOT NULL,
 updated_at datetime NOT NULL,
 PRIMARY KEY  (operation_id),
 KEY actor_created (actor_id,created_at),
 KEY status_updated (status,updated_at),
 KEY expires (expires_at)
)" . $common,
            'operation_items' => 'CREATE TABLE ' . self::table('operation_items') . " (
 item_id $uuid NOT NULL,
 operation_id $uuid NOT NULL,
 product_id bigint unsigned NOT NULL,
 field varchar(20) NOT NULL,
 base_value varchar(64) NOT NULL,
 base_revision bigint unsigned NOT NULL,
 target_value varchar(64) NOT NULL,
 status varchar(20) NOT NULL,
 canonical_result_json longtext DEFAULT NULL,
 error_code varchar(64) DEFAULT NULL,
 event_id bigint unsigned DEFAULT NULL,
 created_at datetime NOT NULL,
 updated_at datetime NOT NULL,
 PRIMARY KEY  (item_id),
 UNIQUE KEY operation_product_field (operation_id,product_id,field),
 KEY operation_status (operation_id,status)
)" . $common,
        ];
    }
    public static function activate(): void {
        if (is_multisite()) { wp_die(esc_html__('รุ่นนี้ยังไม่รองรับ multisite', 'sdd-stock-price')); }
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        foreach (self::definitions() as $sql) { dbDelta($sql); }
        if (self::ready(false)) { update_option('sdd_schema_version', self::VERSION, false); }
        self::grantRoleCapabilities();
        add_option('sdd_settings', ['brand_ids' => [], 'confirmation_mode' => 'always', 'write_stop' => true, 'local_ack' => false], '', false);
    }
    /** Grant the plugin workflow to administrators and store managers; technical logs stay administrator-only. */
    public static function grantRoleCapabilities(): void {
        $administrator = get_role('administrator');
        if ($administrator) {
            foreach (['sdd_view_products', 'sdd_edit_products', 'sdd_manage_settings', 'sdd_view_audit', 'sdd_view_system_logs', 'sdd_bulk_edit', 'sdd_rollback'] as $cap) { $administrator->add_cap($cap); }
        }
        $shopManager = get_role('shop_manager');
        if ($shopManager) {
            foreach (['sdd_view_products', 'sdd_edit_products', 'sdd_manage_settings', 'sdd_view_audit', 'sdd_bulk_edit', 'sdd_rollback'] as $cap) { $shopManager->add_cap($cap); }
        }
    }
    /** One-time upgrade migration for sites where plugin updates did not run the activation hook. */
    public static function upgradeRoleCapabilities(): void {
        if (!current_user_can('manage_options') || get_option('sdd_role_caps_version') === '1') { return; }
        if (!get_role('administrator') || !get_role('shop_manager')) { return; }
        self::grantRoleCapabilities();
        update_option('sdd_role_caps_version', '1', false);
        wp_get_current_user()->get_role_caps();
    }
    public static function ready(bool $version = true): bool {
        global $wpdb;
        if ($version && get_option('sdd_schema_version') !== self::VERSION) { return false; }
        foreach (self::definitions() as $name => $sql) {
            $table = self::table($name);
            $engine = $wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table));
            if ($engine !== 'InnoDB') { return false; }
            preg_match_all('/^ ([a-z_]+) (?:bigint|varchar|char|longtext|datetime)/m', $sql, $matches);
            $cols = $wpdb->get_col("SHOW COLUMNS FROM `$table`");
            if (array_diff($matches[1], $cols)) { return false; }
            // The unique identities are required for replay and audit correctness.
            $indexes = $wpdb->get_results("SHOW INDEX FROM `$table`", ARRAY_A);
            $found = []; $all = [];
            foreach ($indexes as $index) { $all[$index['Key_name']][]=$index['Column_name']; if ((int) $index['Non_unique'] === 0) { $found[$index['Key_name']][] = $index['Column_name']; } }
            if ($name==='events' && ($all['product_history']??[])!==['product_id','id']) { return false; }
            if ($name==='operations' && ($all['status_updated']??[])!==['status','updated_at']) { return false; }
            $required = ['external_observations' => ['PRIMARY' => ['id'], 'linked_event' => ['event_id']], 'feed_state' => ['PRIMARY' => ['id']], 'publications' => ['PRIMARY' => ['sequence'], 'event_identity' => ['event_id']], 'temporary_sales' => ['PRIMARY' => ['id']], 'events' => ['PRIMARY' => ['id'], 'item_field' => ['item_id', 'field']], 'field_state' => ['PRIMARY' => ['product_id', 'field']], 'operations' => ['PRIMARY' => ['operation_id']], 'operation_items' => ['PRIMARY' => ['item_id'], 'operation_product_field' => ['operation_id', 'product_id', 'field']]][$name];
            foreach ($required as $key => $columns) { if (($found[$key] ?? []) !== $columns) { return false; } }
        }
        foreach ([$wpdb->posts, $wpdb->postmeta, $wpdb->options, $wpdb->prefix . 'wc_product_meta_lookup'] as $table) {
            if ($wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table)) !== 'InnoDB') { return false; }
        }
        return true;
    }
}
