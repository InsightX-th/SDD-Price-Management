# แผนปรับราคาให้ตรงกันทุกหน้าร้าน (Cloudflare)

วันที่ปรับแผน: 2 พฤศจิกายน 2026
ฐานโค้ดที่ตรวจ: ปลั๊กอิน 0.5.29, core schema version 5
สถานะ: เริ่มพัฒนา runtime และทดสอบบน Local แล้ว ดู [implementation และข้อจำกัด](cloudflare-auto-purge.md); ยังไม่ทดสอบ Cloudflare จริงหรือ Prod

เอกสารนี้อธิบายการเชื่อมการบันทึกราคากับการล้างข้อมูลหน้าร้านบน Cloudflare โดยอิงโค้ดปลั๊กอินและเอกสาร handoff ค่าของ Cloudflare บน Prod ยังต้องตรวจอีกครั้ง

## การปรับจากแผนตั้งต้น

รุ่น Local ปัจจุบันย้ายการเชื่อมต่อมาไว้ในปลั๊กอิน ใช้ token ที่เข้ารหัสในฐานข้อมูล และใช้ prefix purge เพื่อไม่ต้องกำหนดจำนวนสินค้าต่อหน้าหรือประเภทอุปกรณ์ รายละเอียดเรื่อง environment-only credentials, per-page setting และอุปกรณ์แบบเลือกเองด้านล่างเป็นแผนตั้งต้นที่ถูกแทนที่แล้ว ดู [คู่มือปัจจุบัน](cloudflare-auto-purge.md) เป็นหลัก

## ภาพรวมสำหรับผู้ดูแลร้าน

เมื่อแก้ราคาผ่าน SoundDD ระบบจะเก็บรายการหน้าเว็บที่ต้องอัปเดตไว้ แล้วส่งให้ Cloudflare ล้างข้อมูลเก่าหลังบันทึกราคาเสร็จ หากการเชื่อมต่อมีปัญหา รายการยังอยู่ให้ลองใหม่ได้ การลองใหม่ไม่เปลี่ยนราคาสินค้า

ขณะนี้โค้ดรุ่นทดลองอยู่ในเครื่องนักพัฒนา ยังไม่ได้เปิดใช้บน Prod และยังไม่ได้ทดสอบกับ Cloudflare จริง คู่มือสำหรับผู้ดูแลอยู่ที่ [อัปเดตราคาหน้าร้านอัตโนมัติ](cloudflare-auto-purge.md)

## รายละเอียดสำหรับนักพัฒนา

### 1. ผลลัพธ์ที่ต้องการ

เมื่อผู้ใช้เปลี่ยนราคา ระบบบันทึกราคาและงานอัปเดตแคชอย่างเชื่อมโยงกัน จากนั้นส่งงานไป Cloudflare หลัง transaction สำเร็จ ผู้ใช้เห็นสถานะติดตามโดยไม่ต้องบันทึกราคาซ้ำ ครอบคลุม inline edit, bulk, rollback และการเริ่ม/คืนราคาโปรชั่วคราวของ SDD

ระยะแรกไม่เปลี่ยนกฎคำนวณราคา ไม่เปลี่ยนไปใช้ `/wc/v3` ไม่เขียน SQL ทับราคาตรง ๆ และไม่ใช้ Purge Everything เป็นการทำงานปกติ

การที่ Cloudflare รับคำขอสำเร็จไม่เท่ากับตรวจพบราคาใหม่บนทุกหน้า ต้องรายงานสองเรื่องนี้แยกกัน รวมถึงไม่รับประกันการเปลี่ยนราคาบนหน้าเบราว์เซอร์ที่เปิดค้างอยู่

## 2. จุดเชื่อมกับโค้ดจริง

| โค้ดปัจจุบัน | สิ่งที่จะเพิ่ม |
|---|---|
| `includes/writer.php`, `Writer::transition()` | เก็บ outbox ก่อน COMMIT สุดท้าย เมื่อเกิดการเปลี่ยนข้อมูลจริง; ปลุก worker หลัง COMMIT โดยไม่เรียก HTTP ใน transaction |
| `includes/bulk.php` | ใช้ writer เดิม ไม่เพิ่ม purge ทุก iteration; สรุปสถานะคิวจาก child operations |
| `includes/temporary-sales.php`, `process()` | เริ่มและคืนราคาผ่าน writer อยู่แล้ว จึงได้ outbox ตามการเปลี่ยนราคาจริง |
| `Writer::salePlan()` | ล้างเมื่อเปลี่ยนราคา/ตารางโปรที่มีผลต่อเนื้อหาหน้า; การสร้างแผนอนาคตอย่างเดียวไม่แสดงว่าราคาหน้าร้านเปลี่ยนแล้ว |
| `includes/workspace-sync.php`, `WorkspaceSync::read()` | เพิ่มสถานะแคชให้เฉพาะสินค้าที่ผู้ใช้มองเห็น ใน heartbeat เดิม จำกัดครั้งละ 100 IDs |
| `includes/api.php` | เพิ่ม API สถานะ/ประวัติ/retry/settings แยกจาก API บันทึกราคาและ operation result เดิม |
| `assets/app.js`, `assets/app.css` | เพิ่มสถานะสั้นในผลบันทึก/รายละเอียดสินค้า และสรุปข้อผิดพลาดใน Dashboard/Settings |
| `includes/dashboard.php`, `includes/inspection.php` | เพิ่มจำนวนงานค้าง อายุงานเก่าสุด worker ล่าสุด และสถานะการตั้งค่า โดยไม่รวมเป็นความล้มเหลวของการบันทึกราคา |
| `includes/system-logs.php`, `includes/retention.php` | เพิ่ม log แบบตัดข้อมูลลับ และ cleanup ของคิวที่จบแล้วแบบจำกัด batch |
| `sdd-stock-price.php` | โหลดโมดูลใหม่, boot หลัง WooCommerce พร้อม, ยกเลิก dispatch ตอน deactivate โดยเก็บข้อมูลคิว |

`Writer::fresh()` ปัจจุบันล้าง WP/WC cache แต่ไม่ใช่ Cloudflare edge purge ส่วน `ExternalChanges` มีข้อจำกัดเมื่อใช้ external object cache จึงไม่ใช้เป็นแหล่งหลักเพื่อรับประกันงานของ SDD

## 3. Phase 0: ยืนยันสาเหตุและกำหนดเจ้าของ purge

ทำบน staging ที่มี cache rules เทียบเท่า Prod ก่อน หรือทดสอบสินค้าบน Prod ภายใต้ขอบเขตที่ตกลงเฉพาะครั้ง

1. เก็บ URL/SKU ที่เกิดปัญหา เวลาที่เปลี่ยนราคา operation ID ผลตอบกลับ และราคา regular/sale/effective ที่อ่านจาก WooCommerce ฝั่ง origin
2. เปิดหน้าสินค้าแบบไม่ล็อกอินสองครั้งเพื่ออุ่นแคช บันทึกราคา HTML และ `cf-cache-status`, `cf-apo-via`, `age`, `cache-control`; ทำ desktop/mobile/tablet
3. เปลี่ยนผ่าน SDD แล้วเทียบ Product, variation selector, Shop, Category และ Cart/Checkout; แยก `noop`, conflict, unknown ออกจากการบันทึกสำเร็จ
4. ทดลอง purge เฉพาะ URL พร้อม cache key ที่ถูกต้อง หากราคาถูกต้องหลัง purge จึงมีหลักฐานสนับสนุนว่า edge cache เป็นตัวขวาง
5. ตรวจ Cloudflare plugin รุ่น/ตัวเลือกบน Prod, page/object cache, Redis, canonical hostname, Cache Rules, Workers และ custom keys โดยไม่เก็บ credentials ลงหลักฐาน
6. ตรวจว่าการ purge เดิมถูกเรียกระหว่าง `$p->save()` ก่อน COMMIT หรือไม่ และตรวจผล API จริง ไม่ถือว่า hook ชื่อ `cloudflare_purged_urls` เป็นหลักฐานความสำเร็จ

**เจ้าของ purge:** เป้าหมายคือให้ SDD เป็นผู้รับผิดชอบงานจาก SDD หลัง commit ส่วนการแก้ผ่าน WooCommerce ปกติยังให้ระบบเดิมดูแล ต้องเลือกวิธีป้องกันการล้างก่อน commit/ซ้ำตาม Cloudflare plugin รุ่นที่ตรวจแล้ว ไม่ปิด automatic purge ทั้งไซต์ และไม่สมมติว่ามี filter ที่ suppress ได้โดยไม่ตรวจซอร์สและทดสอบจริง หากแยกไม่ได้ให้บันทึกข้อจำกัดและพิสูจน์ว่าการ purge หลัง commit ยังแก้ stale cache ได้ก่อนเปิดใช้

หาก origin ยังเป็นราคาเก่า ให้แก้เส้นทางบันทึกก่อน หาก HTML ถูกต้องแต่ widget/variation ยังเก่า ให้ตรวจ frontend หาก Cart ผิดต้องตรวจ pricing/session แยกจาก APO

## 4. โมดูลและฐานข้อมูลที่เพิ่ม

ชื่อด้านล่างเป็นชื่อเสนอสำหรับพัฒนา ไม่ใช่ API ที่มีอยู่แล้ว

- `includes/cache-schema.php` — `CacheSchema`: ตาราง/version/migration/readiness ของฟีเจอร์นี้
- `includes/cache-purge.php` — `CachePurge`: outbox, dispatch, claims, retry, status projection
- `includes/cache-urls.php` — `CacheURLs`: mapping หน้าที่เกี่ยวข้องและ cache-key variants
- `includes/cloudflare-client.php` — `CloudflareClient`: HTTP, ตรวจ response, rate limit และ redaction

ใช้ schema แยก เช่น option `sdd_cache_schema_version` และ helper `CacheSchema::table()` โดยคง core `Schema::VERSION = 5` ในระยะแรก เหตุผลคือ `Schema::ready()` ตรวจทุกตารางและเป็นเงื่อนไขการเขียนราคาของทั้งระบบ การเพิ่มตาราง optional เข้าไปทันทีจะขยาย failure domain โดยไม่จำเป็น

Migration ทำผ่าน WordPress/dbDelta แบบ idempotent ภายใต้สิทธิ์ผู้ดูแลระบบ ไม่สร้างตารางใน write request หรือใน price transaction ต้องตรวจ InnoDB/unique indexes/required columns ของตารางใหม่ก่อนเปิด capture ปัญหา cache schema แสดงเฉพาะ health ของฟีเจอร์นี้

### ตารางเสนอ

| ตาราง | ข้อมูลและเงื่อนไขสำคัญ |
|---|---|
| `{prefix}sdd_cache_outbox` | UUID, item/operation/product/parent ID, source, snapshot สำหรับ mapping, สถานะ enumeration/delivery, created/updated; unique ตาม item ID + event kind สำหรับ SDD |
| `{prefix}sdd_cache_targets` | outbox ID, canonical URL + headers ที่ normalize แล้ว, target hash, status, attempts, next_attempt_at, claim token/lease, accepted_at, error code; unique `(outbox_id,target_hash)` |

snapshot เก็บเฉพาะข้อมูลจำเป็น เช่น parent, permalink, term IDs และราคา/revision ที่ใช้เชื่อมหลักฐาน ไม่เก็บ token หรือข้อมูลลูกค้า เก็บค่าก่อน/หลังที่จำเป็นก่อน COMMIT เพื่อไม่พลาดความเกี่ยวข้องเดิม หากภายหลังรองรับย้ายหมวด/เปลี่ยน slug

Outbox เป็นแหล่งข้อมูลถาวร; Action Scheduler เป็นตัวเรียก worker ไม่ใช่แหล่งเดียวที่ใช้ยืนยันว่ามีงานอยู่ Target rows ที่ไม่สำเร็จต้องตรวจย้อนกลับไปยัง outbox/operation ได้

## 5. วงจรการทำงานและขอบเขต transaction

1. Writer ใช้ validation, lock, revision, CRUD save และ read-back verification ตามเดิม
2. เมื่อเปลี่ยน `regular_price`, `sale_price`, `sale_dates` หรือ `stock_status` จริง ให้เพิ่ม outbox ภายใน transaction เดียวกับ price/audit ก่อน COMMIT สุดท้าย รวมหลาย field ใน item เดียวเป็นงานเดียว Stock รวมไว้เพราะกระทบข้อความและสมาชิกหน้ารายการได้
3. `noop`, validation failure, conflict และ transaction ที่ rollback ไม่สร้างงานใหม่ การ replay operation เดิมต้องไม่สร้างงานซ้ำ
4. COMMIT สำเร็จแล้วจึงปลุก dispatcher แบบ best effort แยก try/catch จากเส้นทางรายงานผลราคา **scheduler failure หลัง commit ห้ามเปลี่ยนผลเป็น `operation_unknown`**
5. Periodic recovery scan พบ committed pending outbox ได้ แม้ PHP หยุดทันทีหลัง commit ก่อน schedule สำเร็จ
6. Worker ค่อย enumerate URL เป็น batch แล้วสร้าง target rows แบบ idempotent ตรวจ origin cache ที่เกี่ยวข้องก่อน edge purge ตามผล Phase 0
7. หลัง Cloudflare รับคำขอแล้ว mark เฉพาะ target rows ที่อยู่ในคำขอและ claim รอบนั้น เมื่อ enumeration เสร็จและ targets ทั้งหมด accepted จึงแสดง outbox เป็น accepted

**กรณีเขียน outbox ล้มเหลว:** เมื่อเปิด capture แล้ว เลือก rollback การเปลี่ยนราคาครั้งนั้นพร้อมข้อความว่าเก็บงานอัปเดตหน้าร้านไม่สำเร็จ เพื่อรักษาสัญญา atomicity ต้องมี test และแจ้งพฤติกรรมนี้ชัดเจน ข้อนี้ต่างจาก Cloudflare/scheduler ล้มเหลวภายหลัง ซึ่งไม่ย้อนราคาที่ commit แล้ว ผู้ดูแลสามารถปิด capture เพื่อให้เขียนราคาได้ตามเดิม แต่ช่วงที่ปิดไม่มีการรับประกัน auto purge

หากผล COMMIT ไม่ทราบแน่ชัด ให้ใช้ operation reconciliation เดิมและอ่าน outbox ด้วย stable identity ห้ามเดาราคาใหม่หรือสร้าง price write อีกรอบ

## 6. Worker, batching และการแข่งกันของงาน

- ใช้ Action Scheduler ของ environment เมื่อพร้อมหลัง initialization ตรวจ availability จริง ไม่ bundle library อีกชุดโดยไม่จำเป็น หากไม่พร้อมเก็บงานไว้และแสดง unhealthy
- เสนอ hooks `sdd_cache_dispatch` และ `sdd_cache_recover`, group `sdd-cache`; recovery ต้องทำได้โดยไม่เปิดหน้าแอดมิน มี cron/runner ที่ตรวจได้บน staging/Prod
- เริ่มทดลอง debounce 5–10 วินาทีสำหรับงานเดี่ยว และรวมหน้ารวมในช่วงสั้น ๆ; recovery ทุกประมาณหนึ่งนาที ค่านี้ยังเป็นค่าทดลอง ไม่ใช่ SLA
- Claim ด้วย conditional SQL และ lease มี token ตรวจตอน acknowledge; worker ที่หมด lease ห้ามปิดงานของ worker ใหม่
- รวม payload ที่ target hash เหมือนกันข้าม outbox ได้ แต่เก็บ IDs ที่ claim ไว้ชัดเจน งานใหม่ที่เข้าระหว่าง HTTP ต้องคง pending และได้ purge รอบถัดไป ห้าม mark ทั้ง URL เป็นสำเร็จแบบกว้าง ๆ
- จำกัดทั้งเวลา/จำนวนแถวของ enumeration และ dispatch ไม่ให้ bulk หนึ่งชุดยึด worker ทั้งหมด ทำ request หลังปล่อย DB transaction/lock
- จำกัด payload ตาม Cloudflare plan ปัจจุบัน จำนวนที่นับคือ URL+headers entries ไม่ใช่จำนวนสินค้า ตรวจ rate limit และเผื่อ request จากระบบอื่นใน account
- network/5xx/429: exponential backoff + jitter เคารพ Retry-After; 401/403/config ผิด: หยุดการยิงซ้ำถี่ แสดง needs_attention ให้แก้ก่อน replay
- ตรวจ HTTP status และ JSON `success/errors` จริง หาก response ไม่ชัดเจน retry purge ได้เพราะไม่ใช่การเปลี่ยนราคาซ้ำ
- bounded retry จากนั้น needs_attention; มี manual replay ที่บันทึกผู้สั่งและไม่แก้ราคาหรือ audit event เดิม

## 7. คำว่า “ล้างหน้าที่เกี่ยวข้องครบ” สำหรับเว็บนี้

ต้องทำ URL inventory จาก storefront จริงก่อนเปิดใช้ ไม่ประกาศครอบคลุมทั้งเว็บจากการหา permalink เพียงอย่างเดียว

| กลุ่ม | แผน mapping |
|---|---|
| Product / variation | permalink ของสินค้าที่เปิดสาธารณะ; variation ใช้ parent page และตรวจ selector/ช่วงราคา |
| Shop, category และ ancestor category | ล้าง archive ทุกหน้าที่ได้รับผลกระทบ รวม pagination ไม่จำกัดหน้าแรก |
| การเรียงตามราคา/สินค้าลดราคา/สินค้าพร้อมขาย | อาจเปลี่ยนตำแหน่งหรือสมาชิกหลายหน้า ต้อง enumerate ทุก cached page/variant ในขอบเขต archive ที่เกี่ยวข้อง ไม่ใช้เฉพาะหน้าที่สินค้าปรากฏก่อนเปลี่ยน |
| Brand/tag | เว็บนี้ใช้ `product_tag` เป็นแท็กแบรนด์ ตรวจ archive ที่เปิดจริงและ pagination |
| หน้าแรก/landing/บทความโปร | mapping จากหน้าและ block/shortcode ที่ตรวจแล้ว มี allowlist URLs สำหรับส่วนที่หา dependency อัตโนมัติไม่ได้ |
| Search/filter/AJAX | ตรวจว่า endpoint และ query variants ถูก cache หรือไม่ ถ้าถูก cache ต้องมี finite mapping/กติกา invalidation ที่ทดสอบได้ หาก enumerate ไม่ได้ให้ตกลง cache policy สำหรับ endpoint นั้นก่อน rollout |

Enumeration ต้องแบ่ง batch พร้อม cursor และสถานะ incomplete เมื่อยังไม่ครบ ห้ามตัดที่จำนวน URL สูงสุดแล้วแสดง accepted เสมือนครอบคลุมทั้งหมด กรณีรายการหดตัวต้องล้างหน้าท้ายเดิมด้วย หากต้องใช้ข้อมูลจำนวนหน้าก่อนเปลี่ยน ให้เก็บ snapshot ที่จำเป็น

Normalize canonical hostname/trailing slash/query ตามเว็บจริง ใช้ HTTPS และ host allowlist แบบ exact match ไม่ใช้ suffix check ที่รับโดเมนอื่นได้ ห้ามรับ arbitrary URL จาก browser ไป purge/fetch

สำหรับ device cache ให้สร้าง variants ตาม rules จริง รวม desktop/mobile/tablet เมื่อจำเป็น และรวมมิติอื่นเฉพาะที่ตรวจพบ ห้ามส่งสาม variants แบบเดาแล้วถือว่าครบ ไม่มี purge สำหรับ Cart, Checkout, My Account, SDD API หรือข้อมูลส่วนตัว

## 8. API และสิทธิ์ที่เข้ากับระบบเดิม

คง namespace `/sdd/v1`, cookie identity + nonce, rate limit, private/no-store และ accessibility checks เดิม

| API เสนอ | สิทธิ์/หน้าที่ |
|---|---|
| เพิ่ม `cache_updates` ใน `/workspace-sync` | `sdd_view_products`; เฉพาะ IDs ที่ผ่าน `Policy::accessible()` ใช้ batch query และไม่เปิดเผย config/errors ทางเทคนิค |
| `GET /cache-updates` | สถานะตาม product IDs หรือ operation ID ที่ผู้ใช้เข้าถึงได้; operation ต้องตรวจ actor/scope ไม่เปิด global history ให้ทุกคน |
| `POST /cache-updates/{id}/retry` | `manage_options` ในระยะแรก; retry purge เท่านั้น, rate limit, audit และตรวจ job ID |
| `GET/POST /cache-settings` | `manage_options`; แยก option `sdd_cache_settings` ไม่ใส่ค่าใหม่ใน `/settings` เดิมที่ whitelist key และแทนที่ option ทั้งก้อน |
| `GET /cache-health` | `manage_options`; สรุปคิว/error/config/worker ไม่มี secret |

ไม่เพิ่ม live purge status เข้า `canonical_result_json` ของ price operation เพราะเป็นผลที่ต้อง replay ได้เหมือนเดิม ใช้ item/operation ID เชื่อมอ่านสถานะที่เปลี่ยนภายหลังจาก API แยก

`sdd_manage_settings` ปัจจุบันมีทั้ง administrator และ shop_manager จึงไม่ใช้สิทธิ์นี้เพียงอย่างเดียวสำหรับ token/zone/feature toggles หรือ technical error logs ส่ง `canManageCache` จาก Admin config เมื่อเริ่มทำ UI

## 9. UX บน UI ปัจจุบัน

- ไม่เพิ่มคอลัมน์ถาวรทุกแถวในตาราง แสดงข้อความสั้นใกล้ผลบันทึกและในรายละเอียดสินค้า เฉพาะช่วงมีงาน/ผิดพลาด สีพร้อมข้อความและ icon ไม่ใช้สีอย่างเดียว
- ใช้ heartbeat `/workspace-sync` เดิมประมาณทุก 15 วินาทีเพื่ออัปเดตสินค้า visible; ไม่เพิ่ม timer ต่อแถว และไม่แย่ง request budget ของการบันทึก
- Bulk แสดงสรุป “บันทึกราคาแล้ว X รายการ · งานอัปเดตหน้าร้านยังค้าง Y รายการ” โดยแยกหน่วยสินค้า/งาน/URL ไม่ใช้เลขที่ทำให้เข้าใจว่าราคาเขียนไม่สำเร็จ
- Dashboard เพิ่มสรุปใน “สถานะงานอัตโนมัติ” เช่น คิวค้าง/ล่าช้า/ต้องตรวจสอบ ไม่ปนกับสถานะการคืนราคาของโปร
- ในโปรชั่วคราวคงข้อความยืนยันการคืนราคาตามผลของ TemporarySales และเพิ่มบรรทัดสถานะเผยแพร่หน้าร้านแยกกัน การส่ง purge สำเร็จไม่ใช้ยืนยันว่าคืนราคาแล้ว
- Settings เพิ่มการ์ด “การอัปเดตราคาหน้าร้าน” สำหรับ admin; shop manager เห็นได้เฉพาะสถานะที่จำเป็น ไม่มี token/zone controls

| สถานะภายใน | ข้อความผู้ใช้ |
|---|---|
| disabled | ไม่ได้เปิดอัปเดตแคชอัตโนมัติ |
| pending / enumerating / processing | บันทึกราคาแล้ว · กำลังอัปเดตหน้าร้าน |
| retry_wait | บันทึกราคาแล้ว · อัปเดตหน้าร้านล่าช้า ระบบจะลองใหม่ |
| accepted | ส่งคำขออัปเดตหน้าร้านแล้ว |
| needs_attention | บันทึกราคาแล้ว · การอัปเดตหน้าร้านต้องตรวจสอบ |
| unavailable | บันทึกราคาแล้ว · ยังอ่านสถานะอัปเดตหน้าร้านไม่ได้ |

ถ้าภายหลังเพิ่ม verification ให้แสดง “ตรวจพบราคาใหม่บนหน้าสินค้าแล้ว” พร้อม URL/device/time/revision ที่ตรวจ ไม่อ้างว่าทุกหน้าหรือทุกผู้ใช้ถูกต้อง กรณีมีการแก้ราคาถัดไปให้ผลตรวจเก่าเป็น superseded

## 10. Config, logs และ lifecycle

- Token อยู่ server-side ผ่าน environment หรือ wp-config เช่น `SDD_CF_API_TOKEN`; Zone ID/config ไม่ส่งผ่าน localized JS และไม่คืน token ใน REST/log/export
- Token มีสิทธิ์ Cache Purge เฉพาะ zone ที่จำเป็น ไม่ต้องให้ plugin จัดการ DNS หรือแก้ Cache Rules อัตโนมัติ
- flags แยก `capture_enabled`, `dispatch_enabled`, `dry_run`; default ปิดทั้ง capture/dispatch การเปิดต้องผ่าน schema/config/URL inventory/runner checks
- Dry run สร้างแผนและ log โดยไม่ส่ง Cloudflare และใช้สถานะ simulated แยกจาก accepted การเปลี่ยนเป็น live ต้อง replay/revalidate ชัดเจน ไม่ถือว่างาน dry run เคยล้างแล้ว
- ปิด capture: ไม่สร้างงานใหม่ แต่ worker ระบายคิวเดิมได้; ปิด dispatch: หยุดเรียก API และเก็บคิวเดิม ทั้งสองอย่างไม่ rollback ราคา มี timestamps บันทึกช่วงที่ไม่ครอบคลุม
- `write_stop` เดิมยังควบคุม price write/โปร ไม่หยุดงาน purge ของราคาที่เคย commit แล้ว
- Deactivate: ยกเลิก hooks/dispatch ของ SDD cache; activation ตรวจและกู้ scheduling จาก durable pending rows ข้อมูลคิวไม่ถูกลบ
- logs มี operation/job ID, target count, duration, attempt, sanitized error code ไม่มี Authorization header, token, customer cookies หรือ raw response ที่ไม่กรอง
- เก็บ resolved jobs เริ่มต้น 30 วันแบบ batch และปรับจากปริมาณจริง; pending/needs_attention ไม่ลบทิ้งเพราะอายุอย่างเดียว ตรวจ retention เดิมไม่ให้ลบ operation/event ที่ยังเป็นหลักฐานของคิว unresolved

## 11. แบ่งงานส่งมอบ

| ระยะ | สิ่งที่จะส่งมอบ | เกณฑ์ผ่าน |
|---|---|---|
| A — Diagnosis | หลักฐานสินค้าเสียจริง, origin/edge comparison, cache inventory, owner ของ purge | ระบุสาเหตุและชุด URL/cache keys ที่ต้องจัดการได้ |
| B — Local core | optional schema, writer outbox, worker/client แบบ fake, crash/race tests | ไม่ทำลาย price operation/replay และงานไม่หาย |
| C — Local UX | batch status API, heartbeat integration, Dashboard/Settings, retry | ผู้ใช้แยกบันทึกราคากับอัปเดตหน้าร้านได้; สิทธิ์ถูกต้อง |
| D — Staging Cloudflare | dry run แล้ว live จำกัดสินค้า, URL mapping จริง, cron/AS health | ราคาถูกต้องใน cached HTML ของหน้าที่ตกลง ทั้ง device และโปรเริ่ม/จบ |
| E — Prod canary | เปิดกลุ่มเล็ก วัด queue age/API errors/origin load แล้วค่อยขยาย | มีผลทดสอบจริงและขั้นตอนหยุด dispatch/replay ที่ใช้ได้ |

ช่วง A–C ทำบน local ได้ แต่ local ที่ไม่ผ่าน Cloudflare ยืนยันการ purge จริงไม่ได้ ยังไม่กำหนด release version จนขอบเขตและผลทดสอบนิ่ง เป้าหมายเริ่มต้นคือ normal ภายในประมาณ 60 วินาทีและ bulk ภายในประมาณ 5 นาที ต้องวัดบน staging ไม่แสดงเป็น SLA ก่อนพิสูจน์

## 12. Acceptance tests ที่ต้องเพิ่ม

ใช้แนวทาง PHP integration scripts และ Node client tests เหมือนชุด `tests/` ปัจจุบัน แยก Cloudflare HTTP fake สำหรับ local และหลักฐาน live บน staging

1. Inline regular/sale price, variation parent, bulk และ rollback สร้างงานครั้งเดียวตาม item ที่เปลี่ยนจริง
2. Temporary promotion เริ่ม/คืนราคาเข้าคิว; การสร้างแผนอย่างเดียว, noop, conflict และ rollback transaction ไม่สร้างงานราคาสำเร็จปลอม
3. Outbox insert failure ขณะเปิด capture rollback ทั้งราคา/audit/outbox; เมื่อปิด capture เขียนตามพฤติกรรมเดิม
4. หยุดก่อน commit, หลัง commit ก่อน schedule และหลัง HTTP ก่อน acknowledge: recovery ไม่ทำงานหายหรือเปลี่ยนราคาซ้ำ
5. Scheduler exception หลัง commit ไม่เปลี่ยนผลราคาเป็น unknown; operation retry คงผล canonical เดิม
6. Worker สองตัว/lease หมด/new update ระหว่าง purge: งานใหม่ยังต้องได้รับ purge หลัง commit ของตัวเอง
7. Retry network/5xx/429 และ Retry-After; 401/403 หยุดและแจ้ง; HTTP 200 พร้อม `success:false` ไม่เป็น accepted
8. Pagination, sorting, sale/stock membership, variation range และ shared categories; mapping incomplete ไม่รายงาน accepted ทั้งงาน
9. Desktop/mobile/tablet และ custom-key variants ตาม Prod; warm cache ก่อนเทียบราคา HTML จริง ไม่ใช้ MISS หรือ API success อย่างเดียว
10. Cart/Checkout/session/private API ยัง bypass cache และคิดราคาถูกต้อง
11. Read scope/actor, nonce, permissions, arbitrary URL/SSRF prevention และไม่มี token ใน REST/HTML/logs
12. UI heartbeat อ่านแบบ batch, bulk หน่วยชัด, disabled/unavailable/error ต่างกัน, ไม่เพิ่มคอลัมน์จนตารางรก
13. Optional schema migration/re-activation/deactivation/retention ผ่าน และ core writes ยังใช้งานได้เมื่อ optional feature ปิด
14. Bulk 500–1,000 สินค้าบน staging วัดจำนวน target, API requests, queue age, DB และ origin load พร้อมทดสอบ pause/resume
15. รัน regression tests เดิมทั้งหมดโดยไม่แก้ expected ให้กลบความผิดพลาดของธุรกรรม/โปร/สิทธิ์

## 13. ขอบเขตที่ยังไม่รับประกันในรุ่นแรก

การแก้ราคาจาก WooCommerce ปกติ, import, ERP, native WooCommerce scheduled sale หรือ plugin อื่นยังไม่รับประกันโดย outbox ของ SDD ต้องตรวจระบบ purge เดิมให้รองรับก่อน rollout และแสดง coverage นี้ใน Settings หากต้องครอบคลุมเพิ่ม ให้ทำ observer ที่ durable และทดสอบ persistent object cache แยกต่างหาก ไม่ผูกความถูกต้องไว้กับ `ExternalChanges` เพียงตัวเดียว

หัวข้อที่ต้องยืนยันจาก environment: Cloudflare plugin รุ่นจริงและ hook ownership, runner/WP-Cron, canonical host, cache key dimensions, WordPress page cache, archive/filter URLs, home/promotion widgets และช่องทางแก้ราคานอก SDD

## แหล่งอ้างอิงทางเทคนิค

- [Cloudflare APO: Cache by device type](https://developers.cloudflare.com/automatic-platform-optimization/reference/cache-device-type/) — device variants และพฤติกรรมปลั๊กอินทางการที่ต้องตรวจเทียบ runtime
- [Cloudflare: Purge cache key resources](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-cache-key/) — header/query dimensions ในการ purge
- [Cloudflare: Purge by single-file](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/) — ข้อจำกัดของ URL purge
- [Cloudflare: Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/) — limits ตาม plan ต้องตรวจอีกครั้งก่อนทำ client
- [Action Scheduler: Usage](https://actionscheduler.org/usage/) — initialization และ scheduling lifecycle
