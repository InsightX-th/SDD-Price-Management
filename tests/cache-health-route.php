<?php
/** Standalone route input checks. No WordPress database or network calls. */
declare(strict_types=1);
namespace {
    final class WP_Error {
        public function __construct(public string $code, public string $message, public array $data) {}
    }
    function wp_generate_uuid4(): string { return 'fixture-request-id'; }
    function register_rest_route(string $namespace, string $path, array $route): void {
        $GLOBALS['routes'][$path] = $route;
    }
    function add_filter(mixed ...$args): void {}
}
namespace SDD {
    final class CachePurge {
        public static function health(int $page = 1, string $filter = 'all', ?int $jobId = null): array {
            return compact('page', 'filter') + ($jobId === null ? [] : ['job_id'=>$jobId]);
        }
        public static function close(int $id): array { return ['closed'=>$id]; }
    }
}
namespace {
    require __DIR__ . '/../includes/api.php';
    \SDD\API::register();
    $callback = $GLOBALS['routes']['/cache-health']['callback'];
    $checks = 0;
    $request = static fn(array $query) => new class($query) {
        public function __construct(private array $query) {}
        public function get_query_params(): array { return $this->query; }
    };
    $valid = [ [[], 1, 'all'], [['page'=>'2','filter'=>'attention'], 2, 'attention'], [['page'=>3,'filter'=>'pending'], 3, 'pending'] ];
    foreach ($valid as [$query, $page, $filter]) {
        $result = $callback($request($query));
        if ($result !== compact('page', 'filter')) { throw new RuntimeException('Valid health query rejected'); }
        $checks++;
    }
    $targeted = $callback($request(['job_id'=>'42']));
    if ($targeted !== ['page'=>1,'filter'=>'all','job_id'=>42]) { throw new RuntimeException('The queue shortcut did not select the requested job'); }
    $checks++;
    foreach ([['page'=>'0'], ['page'=>'-1'], ['page'=>['1']], ['filter'=>['all']], ['filter'=>'unknown'], ['page'=>'1000000'], ['extra'=>'x'], ['job_id'=>'0'], ['job_id'=>['42']]] as $query) {
        $result = $callback($request($query));
        if (!$result instanceof WP_Error || $result->data['status'] !== 400) { throw new RuntimeException('Invalid health query accepted'); }
        $checks++;
    }
    $close = $GLOBALS['routes']['/cache-updates/(?P<id>[1-9][0-9]{0,17})/close']['callback'];
    foreach ([null, [], ['confirmed'=>false], ['confirmed'=>'true'], ['confirmed'=>true,'extra'=>1], ['confirmed'=>true]] as $input) {
        $r = new class($input) extends ArrayObject {
            public function __construct(private mixed $input) { parent::__construct(['id'=>'99']); }
            public function get_json_params(): mixed { return $this->input; }
            public function get_url_params(): array { return ['id'=>'7']; }
        };
        $result = $close($r);
        if ($input === ['confirmed'=>true]) {
            if ($result !== ['closed'=>7]) { throw new RuntimeException('Confirmed close rejected'); }
        } elseif (!$result instanceof WP_Error || $result->data['status'] !== 400) {
            throw new RuntimeException('Close accepted without explicit confirmation');
        }
        $checks++;
    }
    echo "$checks cache route checks passed\n";
}
