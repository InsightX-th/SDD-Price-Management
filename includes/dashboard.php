<?php
declare(strict_types=1);
namespace SDD;

/** Read-only, bounded operational overview for store managers. */
final class Dashboard {
    private static function product(int $id): ?array {
        if (!Policy::accessible($id)) { return null; }
        $product = wc_get_product($id);
        if (!$product) { return null; }
        return ['id'=>(string)$id, 'name'=>wp_strip_all_tags($product->get_name()), 'sku'=>(string)$product->get_sku()];
    }
    private static function group(array $rows, callable $map): array {
        $limited=count($rows)>100; $items=[];
        foreach (array_slice($rows,0,100) as $row) {
            $product=self::product((int)$row['product_id']);
            if ($product) { $items[]=$product+$map($row); }
        }
        return ['items'=>$items,'limited'=>$limited];
    }
    public static function alerts(array $query): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_view_products')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if ($query) { return API::error('invalid_query','ตัวกรองไม่ถูกต้อง',400); }
        if (!Schema::ready()) { return API::error('schema_unavailable','ตรวจโปรไม่ได้ เพราะฐานข้อมูลยังไม่พร้อม',503); }
        global $wpdb; $now=time()-300; $table=Schema::table('temporary_sales');
        $rows=$wpdb->get_results($wpdb->prepare("SELECT product_id FROM $table WHERE status='needs_review' OR (status='pending' AND starts_at<%d) OR (status='active' AND ends_at<%d) ORDER BY updated_at DESC LIMIT 101",$now,$now),ARRAY_A);
        if ($wpdb->last_error) { return API::error('alerts_unavailable','ตรวจการแจ้งเตือนไม่สำเร็จ',503); }
        foreach (array_slice($rows,0,100) as $row) { if (self::product((int)$row['product_id'])) { return ['state'=>'attention']; } }
        return ['state'=>count($rows)>100?'unknown':'clear'];
    }
    public static function calendar(array $query): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_view_products')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        $month=$query['month']??'';
        if (array_diff(array_keys($query),['month']) || !is_string($month) || !preg_match('/^(20[0-9]{2})-(0[1-9]|1[0-2])$/D',$month)) { return API::error('invalid_query','เดือนที่เลือกไม่ถูกต้อง',400); }
        if (!Schema::ready()) { return API::error('schema_unavailable','ตรวจปฏิทินไม่ได้ เพราะฐานข้อมูลยังไม่พร้อม',503); }
        $start=\DateTimeImmutable::createFromFormat('!Y-m-d',$month.'-01',wp_timezone());
        if (!$start) { return API::error('invalid_query','เดือนที่เลือกไม่ถูกต้อง',400); }
        $end=$start->modify('+1 month'); global $wpdb; $table=Schema::table('temporary_sales');
        $rows=$wpdb->get_results($wpdb->prepare("SELECT id,product_id,status,sale_price,starts_at,ends_at,message FROM $table WHERE starts_at<%d AND ends_at>=%d AND status IN ('pending','active','needs_review','restored','cancelled','missed') ORDER BY starts_at,id LIMIT 201",$end->getTimestamp(),$start->getTimestamp()),ARRAY_A);
        if ($wpdb->last_error) { return API::error('calendar_unavailable','โหลดปฏิทินไม่สำเร็จ กรุณาลองใหม่',503); }
        $items=[]; foreach (array_slice($rows,0,200) as $row) {
            $product=self::product((int)$row['product_id']); if (!$product) { continue; }
            $items[]=$product+['promotion_id'=>$row['id'],'status'=>$row['status'],'price'=>$row['sale_price'],'starts_at'=>(int)$row['starts_at'],'ends_at'=>(int)$row['ends_at'],'message'=>$row['message']];
        }
        return ['items'=>$items,'limited'=>count($rows)>200,'month'=>$month,'server_time'=>gmdate('c')];
    }
    public static function read(array $query): array|\WP_Error {
        if (!current_user_can('sdd_manage_settings') || !current_user_can('sdd_view_products')) { return API::error('forbidden','สิทธิ์ไม่เพียงพอ',403); }
        if (array_diff(array_keys($query),['hours','threshold']) || !in_array($query['hours']??'24',['24','168'],true) || !in_array($query['threshold']??'30',['10','20','30','50'],true)) { return API::error('invalid_query','ตัวกรองไม่ถูกต้อง',400); }
        if (!Schema::ready()) { return API::error('schema_unavailable','ฐานข้อมูลยังไม่พร้อม จึงตรวจรายการไม่ได้',503); }
        global $wpdb;
        $now=time(); $end=$now+(int)($query['hours']??'24')*3600; $threshold=(int)($query['threshold']??'30');
        $sales=Schema::table('temporary_sales'); $events=Schema::table('events');
        $problems=$wpdb->get_results($wpdb->prepare("SELECT product_id,status,message,starts_at,ends_at FROM $sales WHERE status='needs_review' OR (status='pending' AND starts_at<%d) OR (status='active' AND ends_at<%d) ORDER BY updated_at DESC LIMIT 101",$now-300,$now-300),ARRAY_A);
        if ($wpdb->last_error) { return API::error('dashboard_unavailable','อ่านรายการโปรที่ต้องตรวจสอบไม่ได้',503); }
        $upcoming=$wpdb->get_results($wpdb->prepare("SELECT product_id, 'start' AS event_type, starts_at AS event_at FROM $sales WHERE status='pending' AND starts_at BETWEEN %d AND %d UNION ALL SELECT product_id, 'end' AS event_type, ends_at AS event_at FROM $sales WHERE status IN ('pending','active') AND ends_at BETWEEN %d AND %d ORDER BY event_at ASC LIMIT 101",$now,$end,$now,$end),ARRAY_A);
        if ($wpdb->last_error) { return API::error('dashboard_unavailable','อ่านตารางโปรไม่ได้',503); }
        $changes=$wpdb->get_results($wpdb->prepare("SELECT product_id,field,old_value,new_value,created_at FROM $events WHERE field IN ('regular_price','sale_price') AND created_at >= %s AND old_value REGEXP '^[0-9]+$' AND new_value REGEXP '^[0-9]+$' AND CAST(old_value AS DECIMAL(30,0))>0 AND CAST(new_value AS DECIMAL(30,0)) < CAST(old_value AS DECIMAL(30,0)) AND (CAST(old_value AS DECIMAL(30,0))-CAST(new_value AS DECIMAL(30,0)))*100 >= CAST(old_value AS DECIMAL(30,0))*%d ORDER BY id DESC LIMIT 101",gmdate('Y-m-d H:i:s',$now-7*DAY_IN_SECONDS),$threshold),ARRAY_A);
        if ($wpdb->last_error) { return API::error('dashboard_unavailable','อ่านประวัติราคาไม่ได้',503); }
        $health=Inspection::health([]);
        if (is_wp_error($health)) { return $health; }
        return [
            'problems'=>self::group($problems,static fn($r)=>['status'=>$r['status'],'message'=>$r['message']?:($r['status']==='needs_review'?'โปรต้องตรวจสอบ กรุณาตรวจราคาและประวัติ':($r['status']==='pending'?'เลยเวลาเริ่มโปรมากกว่า 5 นาที':'เลยเวลาคืนราคามากกว่า 5 นาที'))]),
            'upcoming'=>self::group($upcoming,static fn($r)=>['event_type'=>$r['event_type'],'at'=>(int)$r['event_at']]),
            'changes'=>self::group($changes,static fn($r)=>['field'=>$r['field'],'old_value'=>$r['old_value'],'new_value'=>$r['new_value'],'at'=>str_replace(' ','T',$r['created_at']).'Z']),
            'jobs'=>array_values(array_filter($health['cron'],static fn($job)=>$job['state']==='warning')),
            'operations'=>$health['queues']['unresolved_operations']??['state'=>'unavailable','count'=>null,'at_least'=>false],
            'server_time'=>gmdate('c',$now),
        ];
    }
}
