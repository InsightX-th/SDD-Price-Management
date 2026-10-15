<?php
declare(strict_types=1);
namespace SDD;
/** Standard WooCommerce CPT store only. All discovery/pagination stays on the server. */
final class Catalog {
    private static array $promotionPageProducts = [];
    private static ?array $promotionCategoryIds = null;
    private static function promotionCategoryIds(): array {
        if (self::$promotionCategoryIds !== null) { return self::$promotionCategoryIds; }
        $term = get_term_by('slug','new-promotion','category');
        if (!$term) { return self::$promotionCategoryIds = []; }
        $children = get_term_children((int)$term->term_id,'category');
        if (is_wp_error($children)) { return self::$promotionCategoryIds = []; }
        return self::$promotionCategoryIds = array_map('intval',array_merge([(int)$term->term_id],$children));
    }
    private static function promotionPostWhere(): string {
        global $wpdb;
        $termIds = self::promotionCategoryIds();
        if (!$termIds) { return '1=0'; }
        $safeIds = implode(',',$termIds);
        return "p.post_type='post' AND p.post_status='publish' AND EXISTS (SELECT 1 FROM $wpdb->term_relationships tr JOIN $wpdb->term_taxonomy tt ON tt.term_taxonomy_id=tr.term_taxonomy_id WHERE tr.object_id=p.ID AND tt.taxonomy='category' AND tt.term_id IN ($safeIds))";
    }
    /** Published articles in the promotion archive, newest first, for the article picker. */
    public static function promotionArticles(): array {
        global $wpdb;
        $where=self::promotionPostWhere();
        $rows=$wpdb->get_results("SELECT p.ID,p.post_title,p.post_date FROM $wpdb->posts p WHERE $where ORDER BY p.post_date DESC,p.ID DESC",ARRAY_A);
        return ['items'=>array_map(static fn($row)=>[
            'id'=>(string)$row['ID'],
            'title'=>wp_strip_all_tags(html_entity_decode($row['post_title'],ENT_QUOTES | ENT_HTML5,'UTF-8')),
            'date'=>substr($row['post_date'],0,10),
            'url'=>esc_url_raw(get_permalink((int)$row['ID'])),
        ],$rows)];
    }
    /** Published posts in /new-promotion/ and its child categories; only explicit product references count. */
    private static function promotionPageProducts(int $postId = 0): array {
        if (isset(self::$promotionPageProducts[$postId])) { return self::$promotionPageProducts[$postId]; }
        global $wpdb;
        $empty = ['parents'=>[], 'variations'=>[]];
        $where=self::promotionPostWhere();
        if ($postId>0) { $where.=$wpdb->prepare(' AND p.ID=%d',$postId); }
        $contents = $wpdb->get_col("SELECT p.post_content FROM $wpdb->posts p WHERE $where");
        $ids=[]; $slugs=[];
        foreach ($contents as $content) {
            if (preg_match_all('/\[(?:ux_products|ux_products_list|products|product|product_page)\b([^\]]*)\]/i',(string)$content,$shortcodes,PREG_SET_ORDER)) {
                foreach ($shortcodes as $shortcode) {
                    $atts=shortcode_parse_atts($shortcode[1]);
                    foreach (['ids','id'] as $key) {
                        if (!isset($atts[$key]) || !is_string($atts[$key]) || !preg_match('/^[0-9,\s]+$/D',$atts[$key])) { continue; }
                        foreach (preg_split('/[\s,]+/',$atts[$key],-1,PREG_SPLIT_NO_EMPTY) as $id) { if ((int)$id>0) { $ids[(int)$id]=true; } }
                    }
                }
            }
            if (preg_match_all('~href\s*=\s*["\']([^"\']*/product/([^/?#"\']+)/?[^"\']*)["\']~i',(string)$content,$links,PREG_SET_ORDER)) {
                foreach ($links as $link) { $slug=sanitize_title(rawurldecode($link[2])); if ($slug!=='') { $slugs[$slug]=true; } }
            }
        }
        if (!$ids && !$slugs) { return self::$promotionPageProducts[$postId] = $empty; }
        $conditions=[];
        if ($ids) { $conditions[]='p.ID IN ('.implode(',',array_keys($ids)).')'; }
        if ($slugs) {
            $safeSlugs=array_map(static fn($slug)=>"'".esc_sql($slug)."'",array_keys($slugs));
            $conditions[]='p.post_name IN ('.implode(',',$safeSlugs).')';
        }
        $parents=[]; $variations=[];
        $rows=$wpdb->get_results("SELECT p.ID,p.post_parent,p.post_type FROM $wpdb->posts p WHERE p.post_status='publish' AND p.post_type IN ('product','product_variation') AND (".implode(' OR ',$conditions).')',ARRAY_A);
        foreach ($rows as $row) {
            if ($row['post_type']==='product') { $parents[(int)$row['ID']]=true; }
            else { $variations[(int)$row['ID']]=true; }
        }
        return self::$promotionPageProducts[$postId]=['parents'=>array_keys($parents),'variations'=>array_keys($variations)];
    }
    private static function sourcePredicate(string $parent, ?string $child, array $q): string {
        if ($q['source']==='') { return '1=1'; }
        $ids=$q['source_ids'];
        $parts=[];
        if ($ids['parents']) { $parts[]="$parent.ID IN (".implode(',',$ids['parents']).')'; }
        if ($child!==null && $ids['variations']) { $parts[]="$child.ID IN (".implode(',',$ids['variations']).')'; }
        return $parts?'('.implode(' OR ',$parts).')':'1=0';
    }
    private static function scope(string $a, string $type = 'product'): string {
        global $wpdb;
        $sql = "$a.post_type='$type' AND $a.post_status='publish'";
        if (!current_user_can('edit_others_products')) { $sql .= $wpdb->prepare(" AND $a.post_author=%d", get_current_user_id()); }
        return $sql;
    }
    private static function variable(string $a): string {
        global $wpdb;
        return "EXISTS (SELECT 1 FROM $wpdb->term_relationships vt JOIN $wpdb->term_taxonomy vx ON vx.term_taxonomy_id=vt.term_taxonomy_id JOIN $wpdb->terms vn ON vn.term_id=vx.term_id WHERE vt.object_id=$a.ID AND vx.taxonomy='product_type' AND vn.slug='variable')";
    }
    private static function meta(string $a, string $key): string {
        global $wpdb;
        return "(SELECT vm.meta_value FROM $wpdb->postmeta vm WHERE vm.post_id=$a.ID AND vm.meta_key='$key' ORDER BY vm.meta_id LIMIT 1)";
    }
    private static function ownSearch(string $a, string $search): string {
        global $wpdb;
        $like = '%' . $wpdb->esc_like($search) . '%';
        $or = [$wpdb->prepare("$a.post_title LIKE %s", $like), $wpdb->prepare(self::meta($a, '_sku') . ' LIKE %s', $like)];
        if (preg_match('/^[1-9][0-9]{0,17}$/D', $search)) { $or[] = $wpdb->prepare("$a.ID=%d", (int)$search); }
        return '(' . implode(' OR ', $or) . ')';
    }
    private static function parentSearch(string $a, string $search): string {
        global $wpdb;
        $or = [self::ownSearch($a, $search)]; $brands = Policy::settings()['brand_ids'] ?? [];
        if ($brands) {
            $ids = implode(',', array_map('intval', $brands)); $like = '%' . $wpdb->esc_like($search) . '%';
            $or[] = $wpdb->prepare("EXISTS (SELECT 1 FROM $wpdb->term_relationships tr JOIN $wpdb->term_taxonomy tt ON tr.term_taxonomy_id=tt.term_taxonomy_id JOIN $wpdb->terms t ON t.term_id=tt.term_id WHERE tr.object_id=$a.ID AND tt.taxonomy='product_tag' AND tt.term_id IN ($ids) AND t.name LIKE %s)", $like);
        }
        return '(' . implode(' OR ', $or) . ')';
    }
    private static function stock(string $a, string $status): string {
        global $wpdb;
        return $wpdb->prepare(self::meta($a, '_stock_status') . '=%s', $status);
    }
    private static function nativeState(string $a,int $now): string {
        $from="CAST(COALESCE(NULLIF(".self::meta($a,'_sale_price_dates_from').",''),'0') AS SIGNED)";
        $to="CAST(COALESCE(NULLIF(".self::meta($a,'_sale_price_dates_to').",''),'0') AS SIGNED)";
        return "(CASE WHEN $from=0 AND $to=0 THEN 'none' WHEN $from<>0 AND $to<>0 AND $from>$to THEN 'invalid' WHEN $to<>0 AND $to<$now THEN 'expired' WHEN $from>$now THEN 'future' ELSE 'active' END)";
    }
    private static function promotion(string $a,array $q): string {
        global $wpdb;$status=$q['promotion'];if($status===''){return '1=1';}
        $table=Schema::table('temporary_sales');$temp="EXISTS (SELECT 1 FROM $table tp WHERE tp.product_id=$a.ID AND tp.status IN ('pending','active','needs_review'))";
        $sale="CAST(COALESCE(NULLIF(".self::meta($a,'_sale_price').",''),'0') AS DECIMAL(30,8))";
        $native=self::nativeState($a,$q['now']);
        $canSeeTemporary=current_user_can('sdd_manage_settings');
        if($status==='current'){
            return $canSeeTemporary?"EXISTS (SELECT 1 FROM $table tp WHERE tp.product_id=$a.ID AND tp.status='active')":'1=0';
        }
        if($status==='future'){
            $temporary=$canSeeTemporary?"EXISTS (SELECT 1 FROM $table tp WHERE tp.product_id=$a.ID AND tp.status='pending') OR ":'';
            $withoutUnresolved=$canSeeTemporary?"NOT ($temp) AND ":'';
            return "($temporary($withoutUnresolved $native='future'))";
        }
        if($status==='review'){
            $temporary=$canSeeTemporary?" OR EXISTS (SELECT 1 FROM $table tp WHERE tp.product_id=$a.ID AND tp.status='needs_review')":'';
            return "($native='invalid'$temporary)";
        }
        if($canSeeTemporary){$visible="NOT ($temp) AND ";}else{$visible='';}
        if(str_starts_with($status,'temporary_')){return $wpdb->prepare("EXISTS (SELECT 1 FROM $table tp WHERE tp.product_id=$a.ID AND tp.status=%s)",substr($status,10));}
        if(in_array($status,['none','unscheduled'],true)){
            return "($visible $native='none' AND $sale".($status==='none'?'<=0':'>0').')';
        }
        return $wpdb->prepare("($visible $native=%s)",$status);
    }
    private static function childPredicates(string $child,string $parent,array $q): array {
        $terms=[];
        if($q['source']!==''){$terms[]=self::sourcePredicate($parent,$child,$q);}
        if($q['search']!==''){$terms[]='('.self::parentSearch($parent,$q['search']).' OR '.self::ownSearch($child,$q['search']).')';}
        if($q['status']!==''){$terms[]=self::stock($child,$q['status']);}
        if($q['promotion']!==''){$terms[]=self::promotion($child,$q);}
        return $terms;
    }
    private static function recentId(string $a,bool $parents=false,?array $q=null): string {
        global $wpdb;$events=Schema::table('events');
        $predicate="e.field IN ('regular_price','sale_price') AND e.source IN ('inline','bulk_action','rollback','native_sale_plan','temporary_start','temporary_restore') AND e.operation_id IS NOT NULL AND e.user_id IS NOT NULL";
        if($parents){$child=self::childBase('rc',$a);if($q){$terms=self::childPredicates('rc',$a,$q);if($terms){$child.=' AND '.implode(' AND ',$terms);}}
            return '(CASE WHEN '.self::variable($a)." THEN (SELECT MAX(e.id) FROM $wpdb->posts rc JOIN $events e ON e.product_id=rc.ID WHERE $predicate AND $child) ELSE ".self::recentId($a).' END)';}
        return "(SELECT MAX(e.id) FROM $events e WHERE $predicate AND e.product_id=$a.ID)";
    }
    private static function query(array $q): array|\WP_Error {
        $search = $q['search'] ?? ''; $page = (int)($q['page'] ?? 1); $size = (int)($q['per_page'] ?? 50);
        $order = $q['order'] ?? 'asc'; $orderby = $q['orderby'] ?? 'name'; $status = $q['stock_status'] ?? '';
        if (!is_string($search) || mb_strlen($search) > 200 || $page < 1 || $page > 100000 || !in_array($size,[20,50,100],true)) { return API::error('invalid_query','ค่าค้นหาหรือการแบ่งหน้าไม่ถูกต้อง',400); }
        if (!in_array($order,['asc','desc'],true) || !in_array($orderby,['name','id','sku','regular_price'],true)) { return API::error('invalid_sort','การเรียงไม่ถูกต้อง',400); }
        if (!in_array($status,array_merge([''],Policy::STOCK),true)) { return API::error('invalid_stock','สถานะไม่ถูกต้อง',400); }
        if (isset($q['all']) && !in_array($q['all'],['0','1'],true)) { return API::error('invalid_query','ตัวเลือกแสดงลูกไม่ถูกต้อง',400); }
        $scope=$q['scope']??'all';$promotion=$q['promotion_status']??'';$source=$q['source']??'';$post=$q['promotion_post']??'';$now=time();
        if(!in_array($source,['','new_promotion'],true)){return API::error('invalid_filter','แหล่งสินค้าไม่ถูกต้อง',400);}
        if($post!==''&&(!is_scalar($post)||!preg_match('/^[1-9][0-9]{0,17}$/D',(string)$post)||$source!=='new_promotion')){return API::error('invalid_filter','บทความโปรโมชันไม่ถูกต้อง',400);}
        if(!in_array($scope,['all','recent'],true)||!in_array($promotion,['','none','unscheduled','active','future','expired','invalid','current','review','temporary_pending','temporary_active','temporary_needs_review'],true)){return API::error('invalid_filter','แท็บหรือสถานะโปรไม่ถูกต้อง',400);}
        if(str_starts_with($promotion,'temporary_')&&!current_user_can('sdd_manage_settings')){return API::error('forbidden','ไม่มีสิทธิ์ดูสถานะโปรชั่วคราว',403);}
        if(($scope==='recent'||$promotion!=='')&&!Schema::ready()){return API::error('schema_unavailable','Schema ไม่พร้อมสำหรับประวัติหรือตัวกรองโปร',503);}
        if($scope==='recent'){$orderby='recent';$order='desc';}
        $source_ids=$source==='new_promotion'?self::promotionPageProducts($post===''?0:(int)$post):['parents'=>[],'variations'=>[]];
        return compact('search','page','size','order','orderby','status','scope','promotion','source','source_ids','now');
    }
    private static function taxonomy(array $q, string $a): array|\WP_Error {
        global $wpdb; $where = [];
        foreach (['category'=>'product_cat','brand'=>'product_tag'] as $key=>$tax) {
            if (empty($q[$key])) { continue; }
            if (!is_scalar($q[$key]) || !preg_match('/^[1-9][0-9]{0,17}$/D',(string)$q[$key])) { return API::error('invalid_filter','ตัวกรองไม่ถูกต้อง',400); }
            $id = (int)$q[$key]; $ids = [$id];
            if ($key === 'brand' && !in_array($id,Policy::settings()['brand_ids'] ?? [],true)) { return API::error('invalid_brand','แบรนด์ยังไม่ได้รับอนุญาต',400); }
            if ($key === 'category') { $children = get_term_children($id,$tax); if (is_wp_error($children)) { return API::error('invalid_filter','ไม่พบหมวดหมู่',400); } $ids = array_merge($ids,$children); }
            $safeIds = implode(',',array_map('intval',$ids));
            $where[] = $wpdb->prepare("EXISTS (SELECT 1 FROM $wpdb->term_relationships tr JOIN $wpdb->term_taxonomy tt ON tr.term_taxonomy_id=tt.term_taxonomy_id WHERE tr.object_id=$a.ID AND tt.taxonomy=%s AND tt.term_id IN ($safeIds))",$tax);
        }
        return $where;
    }
    private static function price(string $a): string { return "CAST(NULLIF(" . self::meta($a,'_regular_price') . ",'') AS DECIMAL(30,8))"; }
    private static function childBase(string $child, string $parent): string { return "$child.post_parent=$parent.ID AND " . self::scope($child,'product_variation'); }
    private static function sortKey(array $q, string $a, bool $parents): string {
        global $wpdb;
        if ($q['orderby'] === 'recent') { return self::recentId($a,$parents,$q); }
        if ($q['orderby'] === 'regular_price') {
            $price = self::price($a);
            if ($parents) { $price = 'CASE WHEN '.self::variable($a).' THEN (SELECT MIN('.self::price('sc').") FROM $wpdb->posts sc WHERE ".self::childBase('sc',$a).") ELSE $price END"; }
            return $price;
        }
        return match($q['orderby']) { 'sku'=>self::meta($a,'_sku'), 'id'=>"$a.ID", default=>"$a.post_title" };
    }
    private static function select(array $q, string $where, bool $parents): array {
        global $wpdb; $key = self::sortKey($q,'p',$parents); $direction = strtoupper($q['order']);
        $empty = $q['orderby'] === 'regular_price' ? 'sort_key IS NULL' : "sort_key IS NULL OR sort_key=''";
        return $wpdb->get_col($wpdb->prepare("SELECT p.ID,$key AS sort_key FROM $wpdb->posts p WHERE $where ORDER BY ($empty) ASC,sort_key $direction,p.ID $direction LIMIT %d OFFSET %d",$q['size'],($q['page']-1)*$q['size']));
    }
    private static function access(): array {
        $reasons = Policy::globalReasons();
        if (!Schema::ready()) { $reasons[]='Schema ไม่พร้อม กรุณาให้ผู้ดูแลตรวจการเปิดใช้ปลั๊กอิน'; }
        if (!current_user_can('sdd_edit_products')) { $reasons[]='บัญชีนี้ไม่มีสิทธิ์แก้ไขสินค้า'; }
        return ['enabled'=>!$reasons,'reasons'=>$reasons,'can_manage_settings'=>current_user_can('sdd_manage_settings')];
    }
    private static function summary(int $id): array {
        global $wpdb;
        $where = self::scope('c','product_variation') . $wpdb->prepare(' AND c.post_parent=%d',$id); $price = self::price('c');
        $sale = "NULLIF(" . self::meta('c','_sale_price') . ", '')"; $stock = self::meta('c','_stock_status');
        $row = $wpdb->get_row("SELECT COUNT(*) AS total,MIN($price) AS minimum,MAX($price) AS maximum,SUM(CASE WHEN $sale IS NOT NULL THEN 1 ELSE 0 END) AS sale_count,SUM(CASE WHEN $stock='instock' THEN 1 ELSE 0 END) AS instock_count,SUM(CASE WHEN $stock='outofstock' THEN 1 ELSE 0 END) AS outofstock_count,SUM(CASE WHEN $stock='onbackorder' THEN 1 ELSE 0 END) AS backorder_count FROM $wpdb->posts c WHERE $where",ARRAY_A);
        $format = static fn($v) => $v === null ? null : rtrim(rtrim((string)$v,'0'),'.');
        return ['count'=>(int)$row['total'],'regular_min'=>$format($row['minimum']),'regular_max'=>$format($row['maximum']),'sale_count'=>(int)$row['sale_count'],'stock_counts'=>['instock'=>(int)$row['instock_count'],'outofstock'=>(int)$row['outofstock_count'],'onbackorder'=>(int)$row['backorder_count']]];
    }
    private static function rows(array $ids, array $access, ?array $q=null): array {
        global $wpdb; $items=[]; $revisionMap=[]; $promotionMap=[]; $recentMap=[];
        _prime_post_caches(array_map('intval',$ids),true,true);
        if (Schema::ready() && $ids) {
            $safe = implode(',',array_map('intval',$ids));
            if(($q['scope']??'all')==='recent'){foreach($wpdb->get_results('SELECT p.ID,e.created_at FROM '.$wpdb->posts.' p JOIN '.Schema::table('events').' e ON e.id='."(CASE WHEN p.post_type='product_variation' THEN ".self::recentId('p').' ELSE '.self::recentId('p',true,$q).' END)'." WHERE p.ID IN ($safe)",ARRAY_A) as $event){$recentMap[$event['ID']]=str_replace(' ','T',$event['created_at']).'Z';}}
            if (current_user_can('sdd_manage_settings')) {
                foreach ($wpdb->get_results('SELECT product_id,status,message FROM '.Schema::table('temporary_sales')." WHERE product_id IN ($safe) AND status IN ('pending','active','needs_review')",ARRAY_A) as $promo) { $promotionMap[$promo['product_id']]=['status'=>$promo['status'],'message'=>$promo['message']]; }
            }
            foreach ($wpdb->get_results('SELECT product_id,field,revision FROM '.Schema::table('field_state')." WHERE product_id IN ($safe)",ARRAY_A) as $s) { $revisionMap[$s['product_id']][$s['field']]=$s['revision']; }
        }
        foreach ($ids as $id) {
            if (!Policy::accessible((int)$id)) { continue; }
            $p=wc_get_product((int)$id); if (!$p) { continue; } $parent=$p->is_type('variation')?$p->get_parent_id():0; $taxId=$parent?:$p->get_id();
            $editable=[];$fieldReasons=[];$revisions=[];$reasons=[];
            foreach (Policy::FIELDS as $field) {
                $fieldReasons[$field]=array_values(array_unique(array_merge(Policy::fieldReasons($p,$field),$access['reasons'])));
                if (!Policy::accessible((int)$id,true)) { $fieldReasons[$field][]='ไม่มีสิทธิ์แก้ไขสินค้านี้หรือสินค้าแม่'; }
                $editable[$field]=!$fieldReasons[$field]; $reasons=array_merge($reasons,$fieldReasons[$field]); $revisions[$field]=(string)($revisionMap[$id][$field]??'0');
            }
            $terms=wp_get_post_terms($taxId,'product_tag',['fields'=>'all']);$brands=[];
            if (!is_wp_error($terms)) { foreach ($terms as $term) { if (in_array((int)$term->term_id,Policy::settings()['brand_ids']??[],true)) { $brands[]=$term->name; } } }
            $image=wp_get_attachment_image_url($p->get_image_id(),'thumbnail');
            $items[]=['id'=>(string)$id,'parent_id'=>$parent?(string)$parent:null,'type'=>$p->get_type(),'name'=>$p->get_name('edit'),'attributes'=>$p->is_type('variation')?wc_get_formatted_variation($p,true,false,false):'','sku'=>$p->get_sku('edit'),'brands'=>$brands,'thumbnail_url'=>$image&&wp_http_validate_url($image)?esc_url_raw($image):null,'edit_url'=>Policy::accessible((int)$id,true)?admin_url('post.php?post='.$taxId.'&action=edit'):null] + Policy::values($p) + ['revisions'=>$revisions,'editable'=>$editable,'readonly_reasons'=>array_values(array_unique($reasons)),'field_readonly_reasons'=>$fieldReasons,'sale_schedule'=>Policy::schedule($p),'variation_summary'=>$p->is_type('variable')?self::summary((int)$id):null,'temporary_sale'=>$promotionMap[$id]??null,'latest_change'=>$recentMap[$id]??null];
        }
        return $items;
    }
    public static function product(int $id): array|\WP_Error {
        if (!current_user_can('sdd_view_products') || !Policy::accessible($id)) { return API::error('not_found','ไม่พบสินค้าที่เข้าถึงได้',404); }
        Writer::fresh($id);
        $items=self::rows([$id],self::access());
        return $items[0] ?? API::error('not_found','ไม่พบสินค้าที่เข้าถึงได้',404);
    }
    public static function snapshots(array $ids): array {
        // Discard request-local metadata without deleting WooCommerce transients.
        foreach($ids as $id){clean_post_cache($id);wp_cache_delete($id,'post_meta');}
        $q=Schema::ready()?self::query(['scope'=>'recent']):null;
        return self::rows($ids,self::access(),is_wp_error($q)?null:$q);
    }
    public static function products(array $input): array|\WP_Error {
        global $wpdb; $q=self::query($input);if(is_wp_error($q)){return $q;} $tax=self::taxonomy($input,'p');if(is_wp_error($tax)){return $tax;}
        $base=self::scope('p');$where=array_merge([$base],$tax);$child=self::childBase('c','p');$variable=self::variable('p');
        // Source, search, stock, promotion and recent must match the same visible child.
        $childTerms=array_merge([$child],self::childPredicates('c','p',$q));
        if($q['scope']==='recent'){$childTerms[]=self::recentId('c').' IS NOT NULL';}
        if($q['source']!==''||$q['search']!==''||$q['status']!==''||$q['promotion']!==''||$q['scope']==='recent'){
            $simple=[];if($q['source']!==''){$simple[]=self::sourcePredicate('p',null,$q);}if($q['search']!==''){$simple[]=self::parentSearch('p',$q['search']);}if($q['status']!==''){$simple[]=self::stock('p',$q['status']);}if($q['promotion']!==''){$simple[]=self::promotion('p',$q);}if($q['scope']==='recent'){$simple[]=self::recentId('p').' IS NOT NULL';}
            $where[]="(($variable AND EXISTS (SELECT 1 FROM $wpdb->posts c WHERE ".implode(' AND ',$childTerms).")) OR (NOT ($variable) AND ".implode(' AND ',$simple).'))';
        }
        $sql=implode(' AND ',$where);$total=(int)$wpdb->get_var("SELECT COUNT(*) FROM $wpdb->posts p WHERE $sql");$count=(int)$wpdb->get_var("SELECT COUNT(*) FROM $wpdb->posts p WHERE $base");$access=self::access();
        return ['items'=>self::rows(self::select($q,$sql,true),$access,$q),'total'=>$total,'catalog_total'=>$count,'pages'=>(int)ceil($total/$q['size']),'page'=>$q['page'],'per_page'=>$q['size'],'brand_configured'=>!empty(Policy::settings()['brand_ids']),'write_access'=>$access,'server_time'=>gmdate('Y-m-d\TH:i:s\Z')];
    }
    public static function variations(int $parentId,array $input): array|\WP_Error {
        global $wpdb;
        $parent=wc_get_product($parentId);
        if (!$parent || !$parent->is_type('variable') || !Policy::accessible($parentId)) { return API::error('not_found','ไม่พบสินค้าแม่ที่เข้าถึงได้',404); }
        $q=self::query($input);if(is_wp_error($q)){return $q;} $tax=self::taxonomy($input,'pp');if(is_wp_error($tax)){return $tax;}
        $where=[self::scope('p','product_variation'),$wpdb->prepare('p.post_parent=%d',$parentId),"EXISTS (SELECT 1 FROM $wpdb->posts pp WHERE pp.ID=p.post_parent AND ".self::scope('pp').($tax?' AND '.implode(' AND ',$tax):'').')'];
        $all=($input['all']??'0')==='1';
        if(!$all&&$q['source']!==''){
            $ids=$q['source_ids'];$parts=[];
            if(in_array($parentId,$ids['parents'],true)){$parts[]='1=1';}
            if($ids['variations']){$parts[]='p.ID IN ('.implode(',',$ids['variations']).')';}
            $where[]=$parts?'('.implode(' OR ',$parts).')':'1=0';
        }
        if(!$all&&$q['search']!==''){$where[]='('.self::ownSearch('p',$q['search'])." OR EXISTS (SELECT 1 FROM $wpdb->posts pp WHERE pp.ID=p.post_parent AND ".self::parentSearch('pp',$q['search']).'))';}
        if(!$all&&$q['status']!==''){$where[]=self::stock('p',$q['status']);}
        if(!$all&&$q['promotion']!==''){$where[]=self::promotion('p',$q);}
        if(!$all&&$q['scope']==='recent'){$where[]=self::recentId('p').' IS NOT NULL';}
        $sql=implode(' AND ',$where);$total=(int)$wpdb->get_var("SELECT COUNT(*) FROM $wpdb->posts p WHERE $sql");$access=self::access();
        return ['parent_id'=>(string)$parentId,'items'=>self::rows(self::select($q,$sql,false),$access,$q),'total'=>$total,'pages'=>(int)ceil($total/$q['size']),'page'=>$q['page'],'per_page'=>$q['size'],'all'=>$all,'server_time'=>gmdate('Y-m-d\TH:i:s\Z')];
    }
}
