<?php
declare(strict_types=1);
namespace SDD;

/** Optional schema: never make the core writer depend on these tables while capture is off. */
final class CacheSchema {
    public const VERSION = '1';
    public static function table(string $name): string {
        global $wpdb;
        if (!in_array($name, ['outbox','targets'], true)) { throw new \InvalidArgumentException('Cache table identifier.'); }
        return $wpdb->prefix . 'sdd_cache_' . $name;
    }
    public static function definitions(): array {
        global $wpdb; $cc = $wpdb->get_charset_collate();
        return [
            'outbox' => 'CREATE TABLE ' . self::table('outbox') . " (
 id bigint unsigned NOT NULL AUTO_INCREMENT,
 item_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operation_id char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 product_id bigint unsigned NOT NULL,
 parent_id bigint unsigned NOT NULL DEFAULT 0,
 source varchar(32) NOT NULL,
 mode varchar(12) NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'pending',
 snapshot_json longtext NOT NULL,
 enumeration_cursor bigint unsigned NOT NULL DEFAULT 0,
 enumerated tinyint NOT NULL DEFAULT 0,
 lease_token varchar(36) NOT NULL DEFAULT '',
 lease_until bigint unsigned NOT NULL DEFAULT 0,
 error_code varchar(64) NOT NULL DEFAULT '',
 retry_count int unsigned NOT NULL DEFAULT 0,
 last_retry_actor bigint unsigned DEFAULT NULL,
 created_at bigint unsigned NOT NULL,
 updated_at bigint unsigned NOT NULL,
 PRIMARY KEY  (id),
 UNIQUE KEY item_identity (item_id),
 KEY product_latest (product_id,id),
 KEY parent_latest (parent_id,id),
 KEY operation_jobs (operation_id,id),
 KEY due (status,lease_until,id)
) ENGINE=InnoDB $cc;",
            'targets' => 'CREATE TABLE ' . self::table('targets') . " (
 id bigint unsigned NOT NULL AUTO_INCREMENT,
 outbox_id bigint unsigned NOT NULL,
 target_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload_json longtext NOT NULL,
 status varchar(24) NOT NULL DEFAULT 'pending',
 attempts int unsigned NOT NULL DEFAULT 0,
 next_attempt_at bigint unsigned NOT NULL,
 lease_token varchar(36) NOT NULL DEFAULT '',
 lease_until bigint unsigned NOT NULL DEFAULT 0,
 accepted_at bigint unsigned DEFAULT NULL,
 error_code varchar(64) NOT NULL DEFAULT '',
 PRIMARY KEY  (id),
 UNIQUE KEY job_target (outbox_id,target_hash),
 KEY due (status,next_attempt_at,lease_until,id),
 KEY job_status (outbox_id,status)
) ENGINE=InnoDB $cc;",
        ];
    }
    public static function migrate(): bool {
        if (!current_user_can('manage_options')) { return false; }
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        foreach (self::definitions() as $sql) { dbDelta($sql); }
        if (!self::ready(false)) { return false; }
        update_option('sdd_cache_schema_version', self::VERSION, false); return true;
    }
    public static function ready(bool $version = true): bool {
        global $wpdb;
        if ($version && get_option('sdd_cache_schema_version') !== self::VERSION) { return false; }
        foreach (self::definitions() as $name => $sql) {
            $table = self::table($name);
            if ($wpdb->get_var($wpdb->prepare('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=%s', $table)) !== 'InnoDB') { return false; }
            preg_match_all('/^ ([a-z_]+) (?:bigint|int|tinyint|varchar|char|longtext)/m', $sql, $matches);
            if (array_diff($matches[1], $wpdb->get_col("SHOW COLUMNS FROM `$table`"))) { return false; }
            $unique = [];
            foreach ($wpdb->get_results("SHOW INDEX FROM `$table`", ARRAY_A) as $index) {
                if ((int)$index['Non_unique'] === 0) { $unique[$index['Key_name']][] = $index['Column_name']; }
            }
            $required = $name === 'outbox' ? ['PRIMARY'=>['id'],'item_identity'=>['item_id']] : ['PRIMARY'=>['id'],'job_target'=>['outbox_id','target_hash']];
            foreach ($required as $key => $columns) { if (($unique[$key] ?? []) !== $columns) { return false; } }
        }
        return true;
    }
}
