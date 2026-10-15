<?php
declare(strict_types=1);
namespace SDD;

if (!defined('ABSPATH')) { exit; }

final class Updater {
    private static bool $booted = false;
    private const OWNER = 'InsightX-th';
    private const REPOSITORY = 'SDD-Price-Management';
    private const SLUG = 'sdd-stock-price';
    private const RELEASE_CACHE = 'sdd_stock_price_latest_release';
    private const RELEASE_ERROR_CACHE = 'sdd_stock_price_release_check_error';

    public static function boot(): void {
        if (self::$booted) { return; }
        self::$booted = true;
        // WordPress dispatches Update URI checks through this host-specific hook.
        add_filter('update_plugins_github.com', [self::class, 'updateUriResponse'], 10, 4);
        // Normalize malformed collection containers before legacy updater callbacks run.
        add_filter('pre_set_site_transient_update_plugins', [self::class, 'normalizeTransient'], 1);
        add_filter('plugins_api', [self::class, 'pluginInformation'], 10, 3);
        $plugin = plugin_basename(SDD_FILE);
        add_filter('plugin_action_links_' . $plugin, [self::class, 'actionLinks']);
        add_filter('network_admin_plugin_action_links_' . $plugin, [self::class, 'actionLinks']);
        add_action('admin_post_sdd_check_updates', [self::class, 'handleCheck']);
        add_action('admin_notices', [self::class, 'checkNotice']);
        add_action('network_admin_notices', [self::class, 'checkNotice']);
        add_action('load-update-core.php', static function (): void {
            if (!empty($_GET['force-check']) && current_user_can('update_plugins')) { self::checkForUpdates(); }
        }, 1);
    }

    public static function normalizeTransient(mixed $transient): mixed {
        if (!is_object($transient)) { return $transient; }
        foreach (['response','no_update'] as $collection) {
            if (isset($transient->{$collection}) && is_object($transient->{$collection})) {
                $transient->{$collection} = get_object_vars($transient->{$collection});
            } elseif (!isset($transient->{$collection}) || !is_array($transient->{$collection})) {
                $transient->{$collection} = [];
            }
        }
        return $transient;
    }

    public static function updateUriResponse(mixed $update, array $pluginData, string $pluginFile, array $locales): mixed {
        if ($pluginFile !== plugin_basename(SDD_FILE) || ($pluginData['UpdateURI'] ?? '') !== self::repositoryUrl()) { return $update; }
        $release = self::latestRelease();
        if ($release === null) { return false; }
        return self::updateDetails($release);
    }

    public static function actionLinks(array $links): array {
        if (current_user_can('update_plugins')) {
            $url = wp_nonce_url(admin_url('admin-post.php?action=sdd_check_updates'), 'sdd_check_updates');
            $links['sdd_check_updates'] = '<a href="' . esc_url($url) . '">ตรวจสอบอัปเดต</a>';
        }
        return $links;
    }

    /** Check only this plugin, bypassing our cache and WordPress.org availability. */
    public static function checkForUpdates(): array {
        if (!current_user_can('update_plugins')) { return ['status' => 'forbidden']; }
        delete_site_transient(self::RELEASE_CACHE);
        delete_site_transient(self::RELEASE_ERROR_CACHE);
        $release = self::latestRelease();
        if ($release === null) { return ['status' => 'error']; }

        $file = plugin_basename(SDD_FILE);
        $state = get_site_transient('update_plugins');
        $state = self::normalizeTransient(is_object($state) ? $state : new \stdClass());
        $state->checked = is_object($state->checked ?? null) ? get_object_vars($state->checked) : (is_array($state->checked ?? null) ? $state->checked : []);
        $state->checked[$file] = SDD_VERSION;
        $details = (object) (self::updateDetails($release) + ['new_version' => $release['version'], 'plugin' => $file, 'id' => self::repositoryUrl()]);
        $available = version_compare($release['version'], SDD_VERSION, '>');
        unset($state->response[$file], $state->no_update[$file]);
        if ($available) { $state->response[$file] = $details; }
        else { $state->no_update[$file] = $details; }
        // Preserve other plugins and their last_checked timestamp.
        set_site_transient('update_plugins', $state);
        return ['status' => $available ? 'available' : 'current', 'version' => $release['version']];
    }

    public static function handleCheck(): void {
        if (!current_user_can('update_plugins')) { wp_die(esc_html__('ไม่มีสิทธิ์อัปเดตปลั๊กอิน', 'sdd-stock-price'), '', ['response' => 403]); }
        check_admin_referer('sdd_check_updates');
        set_transient('sdd_update_notice_' . get_current_user_id(), self::checkForUpdates(), MINUTE_IN_SECONDS);
        wp_safe_redirect(self_admin_url('plugins.php'));
        exit;
    }

    public static function checkNotice(): void {
        if (!current_user_can('update_plugins')) { return; }
        $key = 'sdd_update_notice_' . get_current_user_id();
        $notice = get_transient($key);
        if (!is_array($notice)) { return; }
        delete_transient($key);
        $status = $notice['status'] ?? 'error';
        $version = $notice['version'] ?? '';
        $message = match ($status) {
            'available' => 'SoundDD: พบเวอร์ชัน ' . $version . ' แล้ว กด “อัปเดตตอนนี้” ใต้ชื่อปลั๊กอินเพื่อติดตั้ง',
            'current' => 'SoundDD: ตรวจสอบแล้ว รุ่นที่ติดตั้งเป็นรุ่นล่าสุดหรือใหม่กว่า GitHub Release (รุ่นเสถียรล่าสุด ' . $version . ')',
            default => 'SoundDD: ยังตรวจสอบอัปเดตไม่ได้ กรุณาตรวจว่าเซิร์ฟเวอร์เชื่อมต่อ api.github.com และ github.com ได้ แล้วลองอีกครั้ง',
        };
        echo '<div class="notice ' . ($status === 'error' ? 'notice-warning' : 'notice-success') . ' is-dismissible"><p>' . esc_html($message) . '</p></div>';
    }

    public static function pluginInformation(mixed $result, string $action, object $args): mixed {
        if ($action !== 'plugin_information' || ($args->slug ?? '') !== self::SLUG) { return $result; }

        $release = self::latestRelease();
        if ($release === null) { return $result; }

        $body = trim((string)($release['body'] ?? ''));
        return (object)[
            'name' => 'SoundDD Stock & Price',
            'slug' => self::SLUG,
            'version' => $release['version'],
            'author' => '<a href="https://github.com/' . self::OWNER . '">SoundDD</a>',
            'homepage' => self::repositoryUrl(),
            'requires' => '6.8',
            'requires_php' => '8.2',
            'download_link' => $release['package'],
            'last_updated' => (string)($release['published_at'] ?? ''),
            'sections' => [
                'description' => '<p>จัดการราคา สต็อก และโปรชั่วคราวของสินค้า WooCommerce</p>',
                'installation' => '<p>ติดตั้งหรืออัปเดตจากหน้า ปลั๊กอิน ใน WordPress ได้โดยตรง</p>',
                'changelog' => $body === '' ? '<p>ดูรายละเอียดรุ่นได้ที่หน้า Release ของโครงการ</p>' : wpautop(esc_html($body)),
            ],
        ];
    }

    private static function latestRelease(): ?array {
        $cached = get_site_transient(self::RELEASE_CACHE);
        if (is_array($cached) && isset($cached['version'], $cached['package'])) { return $cached; }
        if (get_site_transient(self::RELEASE_ERROR_CACHE)) { return null; }

        $url = 'https://api.github.com/repos/' . self::OWNER . '/' . self::REPOSITORY . '/releases/latest';
        $response = wp_remote_get($url, [
            'timeout' => 8,
            'redirection' => 2,
            'headers' => [
                'Accept' => 'application/vnd.github+json',
                'X-GitHub-Api-Version' => '2022-11-28',
                'User-Agent' => 'SoundDD-Stock-Price/' . SDD_VERSION,
            ],
        ]);

        if (is_wp_error($response) || wp_remote_retrieve_response_code($response) !== 200) {
            set_site_transient(self::RELEASE_ERROR_CACHE, 1, 10 * MINUTE_IN_SECONDS);
            return null;
        }

        $release = json_decode((string)wp_remote_retrieve_body($response), true);
        if (!is_array($release) || !empty($release['draft']) || !empty($release['prerelease']) || !isset($release['tag_name'])) {
            set_site_transient(self::RELEASE_ERROR_CACHE, 1, 10 * MINUTE_IN_SECONDS);
            return null;
        }

        if (!preg_match('/^v?(\d+\.\d+\.\d+)$/', (string)$release['tag_name'], $versionMatch)) {
            set_site_transient(self::RELEASE_ERROR_CACHE, 1, 10 * MINUTE_IN_SECONDS);
            return null;
        }

        $version = $versionMatch[1];
        $assetName = self::SLUG . '-' . $version . '.zip';
        $assetFound = false;
        foreach (($release['assets'] ?? []) as $asset) {
            if (($asset['name'] ?? '') === $assetName && ($asset['state'] ?? '') === 'uploaded' && (int)($asset['size'] ?? 0) > 0) {
                $assetFound = true;
                break;
            }
        }
        if (!$assetFound) {
            set_site_transient(self::RELEASE_ERROR_CACHE, 1, 10 * MINUTE_IN_SECONDS);
            return null;
        }

        $tag = rawurlencode((string)$release['tag_name']);
        $package = 'https://github.com/' . self::OWNER . '/' . self::REPOSITORY . '/releases/download/' . $tag . '/' . rawurlencode($assetName);
        $result = [
            'version' => $version,
            'package' => $package,
            'body' => is_string($release['body'] ?? null) ? $release['body'] : '',
            'published_at' => is_string($release['published_at'] ?? null) ? $release['published_at'] : '',
        ];
        set_site_transient(self::RELEASE_CACHE, $result, 6 * HOUR_IN_SECONDS);
        delete_site_transient(self::RELEASE_ERROR_CACHE);
        return $result;
    }

    private static function updateDetails(array $release): array {
        return [
            'slug' => self::SLUG,
            'version' => $release['version'],
            'url' => self::repositoryUrl(),
            'package' => $release['package'],
            'requires' => '6.8',
            'requires_php' => '8.2',
        ];
    }

    private static function repositoryUrl(): string {
        return 'https://github.com/' . self::OWNER . '/' . self::REPOSITORY;
    }
}
