<?php
/**
 * Полноэкранный шаблон страницы клуба (не зависит от темы WordPress).
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title><?php echo esc_html( get_bloginfo( 'name' ) ); ?></title>
<?php wp_head(); ?>
</head>
<body class="acl-body">
<div id="acl-app" class="acl"><div class="acl-empty">Загружаю расписание…</div></div>
<noscript><p style="padding:16px">Для работы страницы включите JavaScript.</p></noscript>
<?php wp_footer(); ?>
</body>
</html>
