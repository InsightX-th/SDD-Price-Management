<?php
declare(strict_types=1);
namespace SDD;
final class Policy {
    public const FIELDS = ['regular_price', 'sale_price', 'stock_status', 'sale_dates'];
    public const STOCK = ['instock', 'outofstock', 'onbackorder'];
    public static function settings(): array { return (array) get_option('sdd_settings', []); }
    public static function integer(mixed $value, bool $empty = false): bool {
        return is_string($value) && (($empty && $value === '') || preg_match('/^(0|[1-9][0-9]{0,14})$/D', $value) === 1);
    }
    public static function configured(): bool { return (self::settings()['confirmation_mode'] ?? '') === 'always'; }
    public static function enableReasons(?bool $configured = null): array {
        $reasons = [];
        if (!($configured ?? self::configured())) { $reasons[] = 'ให้ผู้ดูแลบันทึกการตั้งค่าก่อนเปิดการแก้ไข'; }
        if (!Schema::ready()) { $reasons[] = 'โครงสร้างฐานข้อมูลยังไม่พร้อม'; }
        if (wp_using_ext_object_cache()) { $reasons[] = 'พบระบบแคชข้อมูลถาวร (Object cache) ซึ่งปลั๊กอินรุ่นนี้ยังไม่รองรับ'; }
        if (get_option('sdd_external_observation_gap')) { $reasons[] = 'ตรวจพบช่องว่างการบันทึกการเปลี่ยนข้อมูลภายนอก ต้องให้ผู้ดูแลตรวจสอบก่อนเปิดการแก้ไข'; }
        return $reasons;
    }
    public static function globalReasons(): array {
        $reasons = self::enableReasons();
        if (!empty(self::settings()['write_stop'])) { $reasons[] = 'ผู้ดูแลหยุดการบันทึก'; }
        if (empty(self::settings()['local_ack'])) { $reasons[] = 'ต้องยืนยันขอบเขตการใช้งานก่อนเปิดการบันทึก'; }
        return $reasons;
    }
    public static function values(\WC_Product $p): array {
        return ['regular_price' => $p->get_regular_price('edit'), 'sale_price' => $p->get_sale_price('edit'), 'stock_status' => $p->get_stock_status('edit'), 'sale_dates' => ($p->get_date_on_sale_from('edit')?->getTimestamp() ?? '') . '|' . ($p->get_date_on_sale_to('edit')?->getTimestamp() ?? '')];
    }
    /** Canonical timestamps preserve existing time-of-day; date tokens use the WP timezone. */
    public static function normalizeDates(string $value): string|\WP_Error {
        $parts = explode('|', $value);
        if (count($parts) !== 2) { return API::error('invalid_dates', 'รูปแบบวันโปรไม่ถูกต้อง', 400); }
        foreach ($parts as $i => &$part) {
            if ($part === '') { continue; }
            if (preg_match('/^-?(0|[1-9][0-9]{0,11})$/D', $part)) {
                if ((int)$part < -30610224000 || (int)$part > 253402300799) { return API::error('invalid_dates', 'วันโปรอยู่นอกช่วงที่รองรับ', 400); }
                continue;
            }
            if (preg_match('/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/D', $part)) {
                $datetime = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $part, wp_timezone());
                if (!$datetime || $datetime->format('Y-m-d\TH:i') !== $part) { return API::error('invalid_dates', 'วันเวลาโปรไม่มีอยู่จริง', 400); }
                $part = (string)$datetime->getTimestamp(); continue;
            }
            if (!preg_match('/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/D', $part)) { return API::error('invalid_dates', 'วันโปรไม่ถูกต้อง', 400); }
            $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $part, wp_timezone());
            if (!$date || $date->format('Y-m-d') !== $part) { return API::error('invalid_dates', 'วันที่ไม่มีอยู่จริง', 400); }
            $part = (string)$date->setTime($i === 0 ? 0 : 23, $i === 0 ? 0 : 59, $i === 0 ? 0 : 59)->getTimestamp();
        }
        unset($part);
        if ($parts[0] !== '' && $parts[1] !== '' && (int)$parts[0] > (int)$parts[1]) { return API::error('invalid_dates', 'วันสิ้นสุดต้องไม่อยู่ก่อนวันเริ่ม', 400); }
        return implode('|', $parts);
    }
    public static function schedule(\WC_Product $p): array {
        $from = $p->get_date_on_sale_from('edit')?->getTimestamp();
        $to = $p->get_date_on_sale_to('edit')?->getTimestamp();
        $state = !$from && !$to ? 'none' : ($from && $to && $from > $to ? 'invalid' : ($to && $to < time() ? 'expired' : ($from && $from > time() ? 'future' : 'active')));
        return ['state' => $state, 'from' => $from ? gmdate('Y-m-d\TH:i:s\Z', $from) : null, 'to' => $to ? gmdate('Y-m-d\TH:i:s\Z', $to) : null];
    }
    public static function accessible(int $id, bool $write = false): bool {
        $post = get_post($id); $cap = $write ? 'edit_post' : 'read_post';
        if (!$post || $post->post_status !== 'publish' || !in_array($post->post_type, ['product','product_variation'], true) || !current_user_can($cap, $id)) { return false; }
        if (!current_user_can('edit_others_products') && (int)$post->post_author !== get_current_user_id()) { return false; }
        if ($post->post_type === 'product_variation') {
            $parent = wc_get_product((int)$post->post_parent);
            return $parent && $parent->is_type('variable') && self::accessible((int)$post->post_parent, $write);
        }
        return true;
    }
    public static function fieldReasons(\WC_Product $p, string $field): array {
        $reasons = self::globalReasons();
        if (!$p->is_type(['simple','variation'])) {
            $reasons[] = $p->is_type('variable') ? 'สินค้าแม่ variable: ขยายแถวเพื่อแก้แต่ละตัวเลือก' : 'ชนิด ' . $p->get_type() . ' ยังไม่รองรับใน P1; แก้ใน WooCommerce';
            return $reasons;
        }
        if ($field === 'stock_status') {
            if ($p->get_manage_stock('edit') !== false || ($p->is_type('variation') && wc_get_product($p->get_parent_id())?->get_manage_stock('edit') !== false)) { $reasons[] = 'สถานะอ้างอิงจำนวนสต็อก; แก้จำนวนใน WooCommerce'; }
            return $reasons;
        }
        if ($field !== 'sale_dates' && self::schedule($p)['state'] === 'invalid') { $reasons[] = 'วันเริ่ม–สิ้นสุดโปรไม่ถูกต้อง ให้แก้วันโปรใน WooCommerce ก่อนแก้ราคา'; }
        $v = self::values($p);
        // Missing regular price may be initialized; existing fractional/invalid prices are never rounded.
        if (!self::integer($v['regular_price'], true) || !self::integer($v['sale_price'], true)) { $reasons[] = 'ราคาเดิมมีเศษหรือรูปแบบไม่รองรับ; แก้ราคาใน WooCommerce'; }
        if ($field === 'sale_price' && $v['regular_price'] === '') { $reasons[] = 'กำหนดราคาปกติก่อนตั้งราคาโปร'; }
        return $reasons;
    }
    public static function reasons(\WC_Product $p): array {
        $all = [];
        foreach (self::FIELDS as $field) { $all = array_merge($all, self::fieldReasons($p, $field)); }
        return array_values(array_unique($all));
    }
    public static function validate(\WC_Product $p, string $field, string $value, array $acks): true|\WP_Error {
        if ($reasons = self::fieldReasons($p, $field)) { return API::error('write_unavailable', implode('; ', $reasons), 503); }
        $v = self::values($p); $old = $v[$field]; $v[$field] = $value;
        if ($field === 'stock_status' && !in_array($value, self::STOCK, true)) { return API::error('invalid_stock', 'สถานะไม่ถูกต้อง', 400); }
        if ($field === 'stock_status') { return true; } // Price-only restrictions do not block a stock-status change.
        if ($field === 'sale_dates') {
            $normalized = self::normalizeDates($value);
            if (is_wp_error($normalized)) { return $normalized; }
            if ($value !== '|' && ($v['regular_price'] === '' || $v['sale_price'] === '' || (int)$v['sale_price'] >= (int)$v['regular_price'])) { return API::error('price_relation', 'ต้องกำหนดราคาโปรที่ต่ำกว่าราคาปกติก่อนตั้งวันโปร', 400); }
            if ($value !== $old && !in_array('schedule_change', $acks, true)) { return API::error('confirmation_required', 'ยืนยันวันโปร: อาจเริ่มหรือหยุดโปรทันที', 400, ['required_acknowledgements' => ['schedule_change']]); }
            return true;
        }
        foreach (['regular_price', 'sale_price'] as $f) {
            if (!self::integer($v[$f], $f === 'sale_price')) { return API::error('price_policy', 'กรอกราคาเป็นจำนวนเต็มไม่เกิน 15 หลัก โดยไม่ใส่ทศนิยม', 400); }
        }
        if ($v['sale_price'] !== '' && (int) $v['sale_price'] >= (int) $v['regular_price']) { return API::error('price_relation', 'ราคาโปรต้องต่ำกว่าราคาปกติ', 400); }
        $required = [];
        if ($field !== 'stock_status' && $value !== $old) {
            if ($value === '0') { $required[] = 'zero_price'; }
            $required[] = 'price_change';
            if (self::schedule($p)['state'] === 'expired') { $required[] = 'expired_schedule'; }
        }
        if (array_diff($required, $acks)) { return API::error('confirmation_required', 'ยืนยันผลของราคานี้ก่อนบันทึก', 400, ['required_acknowledgements' => $required, 'old_value' => $old, 'new_value' => $value]); }
        return true;
    }
}
