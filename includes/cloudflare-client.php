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
    public static function connection(): array { return ['zone_id'=>self::zone(),'has_token'=>self::token()!=='']; }
    public static function verified(): bool {
        $saved=(array)get_option('sdd_cf_connection',[]);
        return self::configured() && isset($saved['verified']) && hash_equals((string)$saved['verified'],hash('sha256',self::zone().':'.self::token()));
    }
    public static function connect(mixed $in): array|\WP_Error {
        if (!current_user_can('manage_options')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if (!is_array($in)||array_diff(array_keys($in),['zone_id','api_token'])||!is_string($in['zone_id']??null)||!is_string($in['api_token']??null)||!preg_match('/^[a-f0-9]{32}$/D',trim($in['zone_id']))) { return API::error('invalid_connection','ตรวจ Zone ID และ API Token อีกครั้ง',400); }
        $zone=trim($in['zone_id']);$token=trim($in['api_token']);
        if ($token==='') { $token=self::token(); }
        if (strlen($token)<10||strlen($token)>4096||preg_match('/[^\x21-\x7e]/',$token)) { return API::error('invalid_token','กรอก API Token จาก Cloudflare',400); }
        if (!function_exists('openssl_encrypt')) { return API::error('encryption_unavailable','เซิร์ฟเวอร์ยังไม่พร้อมเก็บรหัสเชื่อมต่ออย่างปลอดภัย',503); }
        // Nonexistent, single public URL: verify purge permission without clearing live product pages.
        $url=set_url_scheme(home_url('/sdd-connection-check-'.wp_generate_uuid4().'/'),'https');
        $r=self::request($zone,$token,['files'=>[$url]]);
        if (!$r['ok']) { return API::error('connection_failed','เชื่อมต่อ Cloudflare ไม่สำเร็จ ตรวจ Zone ID และสิทธิ์ Cache Purge ของ API Token',400); }
        $iv=random_bytes(12);$tag='';$cipher=openssl_encrypt($token,'aes-256-gcm',hash('sha256',wp_salt('auth'),true),OPENSSL_RAW_DATA,$iv,$tag);
        if ($cipher===false) { return API::error('encryption_failed','ยังบันทึกรหัสเชื่อมต่อไม่ได้ กรุณาลองใหม่',503); }
        $saved=['zone'=>$zone,'cipher'=>base64_encode($cipher),'iv'=>base64_encode($iv),'tag'=>base64_encode($tag),'verified'=>hash('sha256',$zone.':'.$token)];
        update_option('sdd_cf_connection',$saved,false);
        if (get_option('sdd_cf_connection')!==$saved) { return API::error('connection_save_failed','ตรวจการเชื่อมต่อแล้ว แต่บันทึกไม่ได้ กรุณาลองใหม่',503); }
        return ['ok'=>true,'connection'=>self::connection()];
    }
    public static function configured(): bool { return preg_match('/^[a-f0-9]{32}$/D', self::zone()) === 1 && self::token() !== ''; }
    public static function purge(array $files): array {
        if (!self::configured() || !$files || count($files) > 100) { return ['ok'=>false,'permanent'=>true,'code'=>'configuration','retry_after'=>0]; }
        // Exact allowed URLs + validated header dimensions, even for replayed database payloads.
        foreach ($files as $file) {
            if (!is_array($file) || !CacheURLs::validPayload($file, false)) { return ['ok'=>false,'permanent'=>true,'code'=>'unsafe_target','retry_after'=>0]; }
        }
        $groups=[];
        foreach ($files as $file) {
            if (($file['kind']??'')==='prefix') { $u=wp_parse_url($file['url']);$groups['prefixes'][]=$u['host'].(isset($u['port'])?':'.$u['port']:'').$u['path']; }
            else { $groups['files'][]=$file; }
        }
        foreach ($groups as $kind=>$values) { $r=self::request(self::zone(),self::token(),[$kind=>array_values(array_unique($values,SORT_REGULAR))]);if (!$r['ok']) { return $r; } }
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
