<?php
declare(strict_types=1);
namespace SDD;
/** Post-commit invalidations. Audit IDs are identities, never commit-order cursors. */
final class Feed {
    public static function boot(): void {
        add_action('sdd_feed_publish', [self::class, 'publish']);
        add_action('admin_init', [self::class, 'schedule']);
    }
    public static function schedule(): void {
        if (current_user_can('sdd_manage_settings') && Schema::ready() && !wp_next_scheduled('sdd_feed_publish')) {
            wp_schedule_event(time()+60, 'sdd_minute', 'sdd_feed_publish');
        }
    }
    /** Dedicated connection: never commit/rollback a caller's product transaction. */
    public static function publish(): bool {
        if (!Schema::ready()) { return false; }
        global $wpdb;
        $db = null; $transaction = false;
        try {
            $db = new \wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
            $db->suppress_errors(true);
            if (!$db->dbh || $db->dbh === $wpdb->dbh) { return false; }
            $run = static function (string $sql) use ($db): void { if ($db->query($sql) === false) { throw new \RuntimeException('Publication query failed.'); } };
            $state=Schema::table('feed_state');$published=Schema::table('publications');$events=Schema::table('events');
            $run('SET SESSION innodb_lock_wait_timeout=1');
            $run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            $run('START TRANSACTION');$transaction=true;
            $run("INSERT IGNORE INTO $state (id,sequence) VALUES (1,0)");
            $head=$db->get_var("SELECT sequence FROM $state WHERE id=1 FOR UPDATE");
            if ($head===null || !preg_match('/^(0|[1-9][0-9]{0,17})$/D',(string)$head)) { throw new \RuntimeException('Invalid publication head.'); }
            $ids=$db->get_col("SELECT e.id FROM $events e LEFT JOIN $published p ON p.event_id=e.id WHERE p.event_id IS NULL ORDER BY e.id LIMIT 200");
            if ($db->last_error) { throw new \RuntimeException('Publication scan failed.'); }
            $next=(int)$head;
            foreach ($ids as $id) {
                if ($next>=999999999999999999) { throw new \RuntimeException('Publication sequence exhausted.'); }
                if ($db->insert($published,['sequence'=>++$next,'event_id'=>$id,'published_at'=>gmdate('Y-m-d H:i:s')])===false) { throw new \RuntimeException('Publication insert failed.'); }
            }
            if ($db->update($state,['sequence'=>$next],['id'=>1])===false) { throw new \RuntimeException('Publication head failed.'); }
            $run('COMMIT');$transaction=false;
            return true;
        } catch (\Throwable $e) {
            API::log('publication_failure');return false;
        } finally {
            if ($db) { if ($transaction) { $db->query('ROLLBACK'); } $db->close(); }
        }
    }
    private static function scope(array $ids): string { return hash('sha256',implode(',',$ids)); }
    private static function encode(string $head,array $ids): string {
        $body=rtrim(strtr(base64_encode(wp_json_encode(['v'=>1,'u'=>get_current_user_id(),'s'=>self::scope($ids),'n'=>$head,'t'=>time()])),'+/','-_'),'=');
        return $body.'.'.hash_hmac('sha256',$body,wp_salt('auth'));
    }
    private static function decode(string $token,array $ids): ?string {
        $parts=explode('.',$token);
        if (count($parts)!==2 || !preg_match('/^[A-Za-z0-9_-]+$/D',$parts[0]) || !hash_equals(hash_hmac('sha256',$parts[0],wp_salt('auth')),$parts[1])) { return null; }
        $claims=json_decode((string)base64_decode(strtr($parts[0],'-_','+/'),true),true);
        if (!is_array($claims)||($claims['v']??null)!==1||($claims['u']??null)!==get_current_user_id()||($claims['s']??null)!==self::scope($ids)||!is_int($claims['t']??null)||$claims['t']>time()+30||$claims['t']<time()-86400||!is_string($claims['n']??null)||!preg_match('/^(0|[1-9][0-9]{0,17})$/D',$claims['n'])) { return null; }
        return $claims['n'];
    }
    public static function changes(array $in): array|\WP_Error {
        if (!current_user_can('sdd_view_products')) { return API::error('forbidden','ไม่มีสิทธิ์ดูสินค้า',403); }
        if (array_diff(array_keys($in),['ids','after','limit'])||!is_string($in['ids']??null)||strlen($in['ids'])>1899||!preg_match('/^[1-9][0-9]{0,17}(,[1-9][0-9]{0,17}){0,99}$/D',$in['ids'])||(isset($in['after'])&&(!is_string($in['after'])||strlen($in['after'])>2048))||(isset($in['limit'])&&!is_string($in['limit'])&&!is_int($in['limit']))||!preg_match('/^(?:[1-9][0-9]?|100)$/D',(string)($in['limit']??'50'))) { return API::error('invalid_input','รูปแบบการอ่านเหตุการณ์ไม่ถูกต้อง',400); }
        if (!Schema::ready()) { return API::error('schema_unavailable','Schema ยังไม่พร้อม',503); }
        $ids=array_values(array_unique(explode(',',$in['ids'])));sort($ids,SORT_STRING);
        $after=isset($in['after'])?self::decode($in['after'],$ids):null;
        if (isset($in['after'])&&$after===null) { return API::error('resync_required','กรุณาอ่านข้อมูลล่าสุดใหม่ โดยเก็บค่าที่พิมพ์ไว้',410); }
        global $wpdb;
        $head=(string)($wpdb->get_var('SELECT sequence FROM '.Schema::table('feed_state').' WHERE id=1')??'0');
        if ($wpdb->last_error) { return API::error('feed_unavailable','อ่านเหตุการณ์ไม่ได้ กรุณาลองใหม่',503); }
        if ($after!==null && (int)$after>(int)$head) { return API::error('resync_required','กรุณาอ่านข้อมูลล่าสุดใหม่ โดยเก็บค่าที่พิมพ์ไว้',410); }
        if ($after===null) { return ['items'=>[],'next_cursor'=>self::encode($head,$ids),'has_more'=>false,'bootstrap'=>true]; }
        $visible=array_values(array_filter($ids,static fn($id)=>Policy::accessible((int)$id)));
        $rows=[];$limit=(int)($in['limit']??50);
        if ($visible) {
            $placeholders=implode(',',array_fill(0,count($visible),'%d'));
            $sql='SELECT p.sequence,e.id AS event_id,e.product_id,e.field,e.revision_after AS revision,e.source FROM '.Schema::table('publications').' p JOIN '.Schema::table('events')." e ON e.id=p.event_id WHERE p.sequence>%d AND p.sequence<=%d AND e.product_id IN ($placeholders) ORDER BY p.sequence LIMIT %d";
            $rows=$wpdb->get_results($wpdb->prepare($sql,...array_merge([(int)$after,(int)$head],array_map('intval',$visible),[$limit+1])),ARRAY_A);
            if ($wpdb->last_error) { return API::error('feed_unavailable','อ่านเหตุการณ์ไม่ได้ กรุณาลองใหม่',503); }
        }
        $more=count($rows)>$limit;$rows=array_slice($rows,0,$limit);
        $next=$more?(string)$rows[count($rows)-1]['sequence']:$head;
        return ['items'=>array_map(static fn($row)=>array_map('strval',$row),$rows),'next_cursor'=>self::encode($next,$ids),'has_more'=>$more,'bootstrap'=>false];
    }
}
