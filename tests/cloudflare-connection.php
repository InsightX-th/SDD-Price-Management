<?php
declare(strict_types=1);

// Standalone fixture. All Cloudflare requests are stubbed.
namespace {
    final class WP_Error {
        public function __construct(public string $code, public string $message, public array $data) {}
    }
    $options = [];
    $fixtureHome = 'https://fixture.test/';
    $fixtureEnvironment = 'production';
    $fixtureResponse = 200;
    $fixtureRequests = 0;
    function get_option($key, $default = false) { return $GLOBALS['options'][$key] ?? $default; }
    function update_option($key, $value, $autoload = null) { $GLOBALS['options'][$key] = $value; return true; }
    function current_user_can($capability) { return $capability === 'manage_options'; }
    function home_url($path) { return $GLOBALS['fixtureHome'] . ltrim($path, '/'); }
    function wp_get_environment_type() { return $GLOBALS['fixtureEnvironment']; }
    function wp_generate_uuid4() { return bin2hex(random_bytes(16)); }
    function wp_salt($scheme) { return 'fixture-salt'; }
    function set_url_scheme($url, $scheme) { return $url; }
    function wp_json_encode($value) { return json_encode($value); }
    function is_wp_error($result) { return $result instanceof WP_Error; }
    function wp_remote_post($url, $args) {
        $GLOBALS['fixtureRequests']++;
        $response = $GLOBALS['fixtureResponse'];
        if (is_callable($response)) { $response = $response(); }
        if ($response === 'network') { return new WP_Error('network', 'fixture-private-detail', []); }
        return ['http'=>$response, 'body'=>json_encode(['success'=>$response === 200, 'errors'=>[]])];
    }
    function wp_remote_retrieve_response_code($response) { return $response['http']; }
    function wp_remote_retrieve_body($response) { return $response['body']; }
    function wp_remote_retrieve_header($response, $header) { return ''; }
}

namespace SDD {
    final class CachePurge {
        public static bool $pending = false;
        public static function zoneChangeBlocked(string $zone): bool { return self::$pending && $zone !== CloudflareClient::zone(); }
    }
    final class CacheURLs {
        public static function validPayload(array $file, bool $dry): bool { return $file === ['url'=>'https://fixture.test/product/']; }
    }

    require dirname(__DIR__) . '/includes/api.php';
    require dirname(__DIR__) . '/includes/cloudflare-client.php';

    function check(bool $condition, string $description): void {
        if (!$condition) { throw new \RuntimeException($description); }
        echo "PASS: $description\n";
    }

    $zone = str_repeat('a', 32);
    $otherZone = str_repeat('b', 32);
    $token = 'fixture-connection-token';
    $input = ['zone_id'=>$zone, 'api_token'=>$token];
    $files = [['url'=>'https://fixture.test/product/']];

    check(CloudflareClient::connection()['verification_state'] === 'unconfigured', 'unconfigured site is identified');
    check(!is_wp_error(CloudflareClient::connect($input)) && CloudflareClient::verified(), 'successful connection is verified');
    check(is_string(CloudflareClient::connection()['verified_at']), 'successful check exposes a timestamp');
    check(!str_contains(json_encode(CloudflareClient::connection()), $token), 'connection omits the token');

    $saved = get_option('sdd_cf_connection');
    $legacy = array_diff_key($saved, array_flip(['home', 'environment', 'verified_at', 'verification_id']));
    update_option('sdd_cf_connection', $legacy);
    check(!CloudflareClient::verified() && CloudflareClient::connection()['has_token'], 'legacy credentials survive and require a recheck');
    check(!is_wp_error(CloudflareClient::connect(['zone_id'=>$zone, 'api_token'=>''])), 'legacy saved token can be rechecked without reentry');

    $GLOBALS['fixtureHome'] = 'https://staging.fixture.test/';
    check(!CloudflareClient::verified(), 'changing the site invalidates readiness');
    $GLOBALS['fixtureHome'] = 'https://fixture.test/';
    $GLOBALS['fixtureEnvironment'] = 'staging';
    check(!CloudflareClient::verified(), 'changing the environment invalidates readiness');
    $GLOBALS['fixtureEnvironment'] = 'production';

    CachePurge::$pending = true;
    $before = $GLOBALS['fixtureRequests'];
    $result = CloudflareClient::connect(['zone_id'=>$otherZone, 'api_token'=>$token]);
    check($result->code === 'cache_zone_has_pending_jobs' && $GLOBALS['fixtureRequests'] === $before, 'pending live jobs block other zones before any network call');
    check(!is_wp_error(CloudflareClient::connect($input)), 'same-zone recheck still works while live jobs are pending');
    CachePurge::$pending = false;
    $before = $GLOBALS['fixtureRequests'];
    $result = CloudflareClient::purge($files, $otherZone);
    check($result['code'] === 'configuration_changed' && $GLOBALS['fixtureRequests'] === $before, 'queued work cannot dispatch against another current zone');

    foreach (['network'=>503, 401=>400, 403=>400, 404=>400, 429=>429, 500=>502] as $fixture => $status) {
        $GLOBALS['fixtureResponse'] = $fixture;
        $result = CloudflareClient::connect(['zone_id'=>$zone, 'api_token'=>'different-candidate-token']);
        $expectedCode = $fixture === 'network' ? 'network' : 'cloudflare_' . $fixture;
        check($result->data['status'] === $status && $result->data['cloudflare_code'] === $expectedCode
            && !str_contains($result->message, 'fixture-private-detail') && CloudflareClient::verified(),
            'failed candidate returns sanitized diagnostic ' . $expectedCode . ' and preserves current verification');
    }
    $GLOBALS['fixtureResponse'] = 403;
    CloudflareClient::purge($files, $zone);
    $connection = CloudflareClient::connection();
    check(!CloudflareClient::verified() && $connection['last_failure'] === 'cloudflare_403' && $connection['verified_at'] !== null,
        'failed active credentials require rechecking and retain the last successful test timestamp');

    $GLOBALS['fixtureResponse'] = 200;
    CloudflareClient::connect($input);
    check(CloudflareClient::verified() && CloudflareClient::connection()['last_failure'] === null, 'successful recheck clears stale failure');

    $GLOBALS['fixtureResponse'] = static function () use ($input): int {
        $GLOBALS['fixtureResponse'] = 200;
        CloudflareClient::connect($input);
        return 403;
    };
    CloudflareClient::purge($files, $zone);
    check(CloudflareClient::verified(), 'older failure does not invalidate a newer completed recheck');
}
