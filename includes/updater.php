<?php
declare(strict_types=1);
namespace SDD;

if (!defined('ABSPATH')) { exit; }

final class Updater {
    private const OWNER = 'InsightX-th';
    private const REPOSITORY = 'SDD-Price-Management';
    private const SLUG = 'sdd-stock-price';
    private const RELEASE_CACHE = 'sdd_stock_price_latest_release';
    private const RELEASE_ERROR_CACHE = 'sdd_stock_price_release_check_error';

    public static function boot(): void {
        add_filter('pre_set_site_transient_update_plugins', [self::class, 'filterUpdates']);
        add_filter('plugins_api', [self::class, 'pluginInformation'], 10, 3);
    }

    public static function filterUpdates(mixed $transient): mixed {
        if (!is_object($transient) || empty($transient->checked) || !is_array($transient->checked)) { return $transient; }

        $pluginFile = plugin_basename(SDD_FILE);
        if (!array_key_exists($pluginFile, $transient->checked)) { return $transient; }

        $release = self::latestRelease();
        if ($release === null) { return $transient; }

        if (!isset($transient->response) || !is_object($transient->response)) { $transient->response = (object)[]; }
        if (!isset($transient->no_update) || !is_object($transient->no_update)) { $transient->no_update = (object)[]; }

        $details = self::updateDetails($pluginFile, $release);
        if (version_compare($release['version'], SDD_VERSION, '>')) {
            $transient->response->{$pluginFile} = $details;
            unset($transient->no_update->{$pluginFile});
        } else {
            $transient->no_update->{$pluginFile} = $details;
            unset($transient->response->{$pluginFile});
        }
        return $transient;
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

    private static function updateDetails(string $pluginFile, array $release): object {
        return (object)[
            'slug' => self::SLUG,
            'plugin' => $pluginFile,
            'new_version' => $release['version'],
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
