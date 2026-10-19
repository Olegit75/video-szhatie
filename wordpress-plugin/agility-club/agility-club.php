<?php
/**
 * Plugin Name: Аджилити-клуб
 * Description: Расписание тренировок в манеже, отметки участия и оплаты, расчёт стоимости, новости и видео. Вставьте шорткод [agility_club] на страницу.
 * Version: 1.7.1
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: Аджилити-клуб
 * Text Domain: agility-club
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ACL_VERSION', '1.7.1' );
define( 'ACL_FILE', __FILE__ );
define( 'ACL_DIR', plugin_dir_path( __FILE__ ) );
define( 'ACL_URL', plugin_dir_url( __FILE__ ) );
define( 'ACL_CAP', 'acl_manage' );

require_once ACL_DIR . 'includes/class-acl-db.php';
require_once ACL_DIR . 'includes/class-acl-calc.php';
require_once ACL_DIR . 'includes/class-acl-api.php';
require_once ACL_DIR . 'includes/class-acl-front.php';
require_once ACL_DIR . 'includes/class-acl-video.php';
require_once ACL_DIR . 'includes/class-acl-course.php';

register_activation_hook( __FILE__, array( 'ACL_DB', 'activate' ) );

add_action( 'plugins_loaded', array( 'ACL_DB', 'maybe_upgrade' ) );
add_action( 'rest_api_init', array( 'ACL_API', 'register' ) );
add_action( 'rest_api_init', array( 'ACL_Video', 'register' ) );
add_action( 'rest_api_init', array( 'ACL_Course', 'register' ) );
ACL_Front::init();
