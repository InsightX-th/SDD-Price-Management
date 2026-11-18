<?php
declare(strict_types=1);
namespace SDD;

/** Fixed endpoint and sanitized results only. No caller-supplied destination or credentials. */
final class CloudflareClient {
    public static function zone(): string { $saved=(array)get_option('sdd_cf_connection',[]); return (string)($saved['zone'] ?? (defined('SDD_CF_ZONE_ID') ? trim((string)SDD_CF_ZONE_ID) : '')); }
    private static function token(): string {
        $saved=(array)get_option('sdd_cf_connection',[]);
        if (isset($saved['cipher'])) {
            if (!function_exists('openssl_decrypt')) { return ''; }
            $value=openssl_decrypt((string)base64_decode($saved['cipher'],true),'aes-256-gcm',hash('sha256',wp_salt('auth'),true),OPENSSL_RAW_DATA,(string)base64_decode($saved['iv'],true),(string)base64_decode($saved['tag'],true));
            return is_string($value)?$value:'';
        }
        return defined('SDD_CF_API_TOKEN') ? trim((string)SDD_CF_API_TOKEN) : trim((string)getenv('SDD_CF_API_TOKEN'));
    }
    public static function connection(): array {
        $saved = (array)get_option('sdd_cf_connection', []);
        $zone = self::zone();
        $token = self::token();
        $hasToken = $token !== '';
        $matches = self::verificationMatches($saved, $zone, $token);
        $failure = $matches ? self::verificationFailure($saved) : null;
        return [
            'zone_id' => $zone,
            'has_token' => $hasToken,
            'verified_at' => $matches ? gmdate('c', $saved['verified_at']) : null,
            'verification_state' => $matches && !$failure ? 'verified' : ($hasToken ? 'recheck_required' : 'unconfigured'),
            'last_failure' => $failure,
        ];
    }
    private static function verificationMatches(array $saved, string $zone, string $token): bool {
        return $token !== '' && preg_match('/^[a-f0-9]{32}$/D', $zone) === 1
            && is_string($saved['verification_id'] ?? null) && $saved['verification_id'] !== ''
            && is_string($saved['verified'] ?? null) && is_int($saved['verified_at'] ?? null)
            && $saved['verified_at'] > 0 && ($saved['home'] ?? '') === home_url('/')
            && ($saved['environment'] ?? '') === wp_get_environment_type()
            && hash_equals($saved['verified'], hash('sha256', $zone . ':' . $token));
    }
    private static function verificationFailure(array $saved): ?string {
        $failure = (array)get_option('sdd_cf_verification_failure', []);
        $code = $failure['code'] ?? null;
        return ($failure['id'] ?? '') === $saved['verification_id'] && is_string($code) ? $code : null;
    }
    public static function hasSavedCredentials(): bool {
        $saved = (array)get_option('sdd_cf_connection', []);
        return isset($saved['cipher']);
    }
    public static function verified(): bool {
        $saved = (array)get_option('sdd_cf_connection', []);
        return self::verificationMatches($saved, self::zone(), self::token()) && !self::verificationFailure($saved);
    }
    private static function invalidateVerification(array $verified, string $zone, string $token, string $code): void {
        if (!in_array($code, ['cloudflare_401','cloudflare_403','cloudflare_404'], true)
            || !self::verificationMatches($verified, $zone, $token)) { return; }
        $current = (array)get_option('sdd_cf_connection', []);
        if (($current['verification_id'] ?? null) !== $verified['verification_id']) { return; }
        // Keep the failure separate so a delayed request cannot overwrite newly saved credentials.
        update_option('sdd_cf_verification_failure', ['id'=>$verified['verification_id'], 'code'=>$code], false);
    }
    private static function connectionError(string $code): \WP_Error {
        [$message, $status] = match ($code) {
            'network' => ['WordPress ติดต่อ Cloudflare ไม่ได้ ให้ผู้ดูแลเซิร์ฟเวอร์ตรวจเครือข่าย DNS และ TLS แล้วลองใหม่', 503],
            'cloudflare_401' => ['Cloudflare ไม่ยอมรับ API Token ตรวจว่า Token ยังใช้งานได้หรือสร้าง Token ใหม่', 400],
            'cloudflare_403' => ['Cloudflare ปฏิเสธสิทธิ์ ตรวจว่า Token มีสิทธิ์ Cache Purge สำหรับ Zone ของเว็บไซต์นี้', 400],
            'cloudflare_404' => ['Cloudflare ไม่พบ Zone ที่เข้าถึงได้ คัดลอก Zone ID จากหน้า Overview ของโดเมน แล้วตรวจขอบเขตของ Token', 400],
            'cloudflare_429' => ['Cloudflare จำกัดจำนวนคำขอชั่วคราว กรุณารอสักครู่แล้วลองใหม่', 429],
            'cloudflare_400', 'cloudflare_422' => ['Cloudflare ไม่รับคำขอตรวจสอบ ตรวจ Zone ID จากหน้า Overview ของโดเมนและที่อยู่เว็บไซต์ใน WordPress', 400],
            default => ['Cloudflare ไม่สามารถยืนยันการเชื่อมต่อได้ในขณะนี้ กรุณาลองใหม่', 502],
        };
        return API::error('connection_failed', $message, $status, ['cloudflare_code'=>$code]);
    }
    public static function connect(mixed $in): array|\WP_Error {
        if (!current_user_can('manage_options')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if (!is_array($in)||array_diff(array_keys($in),['zone_id','api_token'])||!is_string($in['zone_id']??null)||!is_string($in['api_token']??null)||!preg_match('/^[a-f0-9]{32}$/D',trim($in['zone_id']))) { return API::error('invalid_connection','ตรวจ Zone ID และ API Token อีกครั้ง',400); }
        $zone=trim($in['zone_id']);$token=trim($in['api_token']);
        if ($token==='') { $token=self::token(); }
        if (strlen($token)<10||strlen($token)>4096||preg_match('/[^\x21-\x7e]/',$token)) { return API::error('invalid_token','กรอก API Token จาก Cloudflare',400); }
        if (!function_exists('openssl_encrypt')) { return API::error('encryption_unavailable','เซิร์ฟเวอร์ยังไม่พร้อมเก็บรหัสเชื่อมต่ออย่างปลอดภัย',503); }
        if (CachePurge::zoneChangeBlocked($zone)) {
            return API::error('cache_zone_has_pending_jobs', 'ยังเปลี่ยน Zone ID ไม่ได้ เพราะมีงานอัปเดตราคาที่ส่งจริงค้างอยู่ ให้จัดการงานเดิมก่อน', 409);
        }
        $previouslyVerified = (array)get_option('sdd_cf_connection', []);
        $home = home_url('/');
        $environment = wp_get_environment_type();
        // Nonexistent, single public URL: verify purge permission without clearing live product pages.
        $url=set_url_scheme(home_url('/sdd-connection-check-'.wp_generate_uuid4().'/'),'https');
        $r=self::request($zone,$token,['files'=>[$url]]);
        if (!$r['ok']) {
            self::invalidateVerification($previouslyVerified, $zone, $token, $r['code']);
            return self::connectionError($r['code']);
        }
        $iv=random_bytes(12);$tag='';$cipher=openssl_encrypt($token,'aes-256-gcm',hash('sha256',wp_salt('auth'),true),OPENSSL_RAW_DATA,$iv,$tag);
        if ($cipher===false) { return API::error('encryption_failed','ยังบันทึกรหัสเชื่อมต่อไม่ได้ กรุณาลองใหม่',503); }
        if ($home !== home_url('/') || $environment !== wp_get_environment_type()) {
            return API::error('cache_site_changed', 'ที่อยู่เว็บไซต์เปลี่ยนระหว่างการตรวจสอบ กรุณาตรวจการเชื่อมต่อใหม่', 409);
        }
        if (CachePurge::zoneChangeBlocked($zone)) {
            return API::error('cache_zone_has_pending_jobs', 'ยังเปลี่ยน Zone ID ไม่ได้ เพราะมีงานอัปเดตราคาที่ส่งจริงค้างอยู่ ให้จัดการงานเดิมก่อน', 409);
        }
        $saved=['zone'=>$zone,'cipher'=>base64_encode($cipher),'iv'=>base64_encode($iv),'tag'=>base64_encode($tag),'verified'=>hash('sha256',$zone.':'.$token),'home'=>$home,'environment'=>$environment,'verified_at'=>time(),'verification_id'=>wp_generate_uuid4()];
        update_option('sdd_cf_connection',$saved,false);
        if (get_option('sdd_cf_connection')!==$saved) { return API::error('connection_save_failed','ตรวจการเชื่อมต่อแล้ว แต่บันทึกไม่ได้ กรุณาลองใหม่',503); }
        return ['ok'=>true,'connection'=>self::connection()];
    }
    public static function configured(): bool { return preg_match('/^[a-f0-9]{32}$/D', self::zone()) === 1 && self::token() !== ''; }
    public static function purge(array $files, ?string $expectedZone = null): array {
        $verification = (array)get_option('sdd_cf_connection', []);
        $zone = self::zone();
        $token = self::token();
        if ($expectedZone !== null && $zone !== $expectedZone) { return ['ok'=>false,'permanent'=>true,'code'=>'configuration_changed','retry_after'=>0]; }
        if (!preg_match('/^[a-f0-9]{32}$/D', $zone) || $token === '' || !$files || count($files) > 100) { return ['ok'=>false,'permanent'=>true,'code'=>'configuration','retry_after'=>0]; }
        // Exact allowed URLs + validated header dimensions, even for replayed database payloads.
        foreach ($files as $file) {
            if (!is_array($file) || !CacheURLs::validPayload($file, false)) { return ['ok'=>false,'permanent'=>true,'code'=>'unsafe_target','retry_after'=>0]; }
        }
        $groups=[];
        foreach ($files as $file) {
            if (($file['kind']??'')==='prefix') { $u=wp_parse_url($file['url']);$groups['prefixes'][]=$u['host'].(isset($u['port'])?':'.$u['port']:'').$u['path']; }
            else { $groups['files'][]=$file; }
        }
        foreach ($groups as $kind=>$values) {
            $r = self::request($zone, $token, [$kind=>array_values(array_unique($values,SORT_REGULAR))]);
            if (!$r['ok']) {
                self::invalidateVerification($verification, $zone, $token, $r['code']);
                return $r;
            }
        }
        return ['ok'=>true,'permanent'=>false,'code'=>'','retry_after'=>0];
    }
    private static function request(string $zone, string $token, array $payload): array {
        $r = wp_remote_post('https://api.cloudflare.com/client/v4/zones/' . $zone . '/purge_cache', [
            'timeout'=>12, 'redirection'=>0, 'sslverify'=>true,
            'headers'=>['Authorization'=>'Bearer ' . $token,'Content-Type'=>'application/json'],
            'body'=>wp_json_encode($payload), 'limit_response_size'=>65536,
        ]);
        if (is_wp_error($r)) { return ['ok'=>false,'permanent'=>false,'code'=>'network','retry_after'=>0]; }
        $http = wp_remote_retrieve_response_code($r); $body = json_decode(wp_remote_retrieve_body($r), true);
        if ($http >= 200 && $http < 300 && is_array($body) && ($body['success'] ?? null) === true && empty($body['errors'])) { return ['ok'=>true,'permanent'=>false,'code'=>'','retry_after'=>0]; }
        $header = (string)wp_remote_retrieve_header($r, 'retry-after');
        $after = ctype_digit($header) ? (int)$header : ($header !== '' ? max(0, (int)strtotime($header) - time()) : 0);
        return ['ok'=>false,'permanent'=>in_array($http,[400,401,403,404,422],true), 'code'=>'cloudflare_' . (int)$http, 'retry_after'=>$after];
    }
}
