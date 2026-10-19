<?php
/**
 * Страница клуба: шорткод [agility_club], собственный полноэкранный шаблон,
 * удобства для участников (без админ-панели, возврат на сайт после входа).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_Front {

	public static function init() {
		add_shortcode( 'agility_club', array( __CLASS__, 'shortcode' ) );
		add_filter( 'template_include', array( __CLASS__, 'template' ), 99 );
		add_filter( 'show_admin_bar', array( __CLASS__, 'admin_bar' ) );
		add_filter( 'login_redirect', array( __CLASS__, 'login_redirect' ), 10, 3 );
		add_action( 'admin_init', array( __CLASS__, 'keep_members_out_of_admin' ) );
		register_activation_hook( ACL_FILE, array( __CLASS__, 'ensure_page' ) );
	}

	/** Создаёт страницу «Клуб» с шорткодом и делает её главной (один раз). */
	public static function ensure_page() {
		$id = (int) get_option( 'acl_page_id' );
		if ( $id && get_post( $id ) && 'trash' !== get_post_status( $id ) ) {
			return;
		}
		$id = wp_insert_post( array(
			'post_title'   => 'Клуб',
			'post_name'    => 'club',
			'post_content' => '[agility_club]',
			'post_status'  => 'publish',
			'post_type'    => 'page',
		) );
		if ( $id && ! is_wp_error( $id ) ) {
			update_option( 'acl_page_id', $id );
			update_option( 'show_on_front', 'page' );
			update_option( 'page_on_front', $id );
		}
	}

	private static function is_app_page() {
		if ( ! is_singular() ) {
			return false;
		}
		$post = get_post();
		return $post && ( (int) get_option( 'acl_page_id' ) === (int) $post->ID || has_shortcode( (string) $post->post_content, 'agility_club' ) );
	}

	public static function template( $template ) {
		if ( self::is_app_page() ) {
			self::enqueue();
			return ACL_DIR . 'templates/app.php';
		}
		return $template;
	}

	public static function enqueue() {
		wp_enqueue_style( 'acl-app', ACL_URL . 'assets/app.css', array(), ACL_VERSION );
		wp_enqueue_script( 'acl-app', ACL_URL . 'assets/app.js', array(), ACL_VERSION, true );
		wp_localize_script( 'acl-app', 'ACL', array(
			'api'   => esc_url_raw( rest_url( ACL_API::NS ) ),
			'nonce' => wp_create_nonce( 'wp_rest' ),
			'site'  => get_bloginfo( 'name' ),
		) );
	}

	public static function shortcode() {
		self::enqueue();
		return '<div id="acl-app" class="acl"><div class="acl-empty">Загружаю расписание…</div></div>';
	}

	public static function admin_bar( $show ) {
		return current_user_can( ACL_CAP ) ? $show : false;
	}

	public static function login_redirect( $redirect_to, $requested, $user ) {
		if ( $user instanceof WP_User && ! user_can( $user, ACL_CAP ) ) {
			$id = (int) get_option( 'acl_page_id' );
			return $id ? get_permalink( $id ) : home_url( '/' );
		}
		return $redirect_to;
	}

	/** Участникам незачем заходить в админку — отправляем на страницу клуба. */
	public static function keep_members_out_of_admin() {
		if ( wp_doing_ajax() || current_user_can( 'edit_posts' ) || current_user_can( ACL_CAP ) ) {
			return;
		}
		if ( is_user_logged_in() && ! ( defined( 'IFRAME_REQUEST' ) && IFRAME_REQUEST ) ) {
			global $pagenow;
			if ( 'profile.php' === $pagenow ) {
				return;
			}
			$id = (int) get_option( 'acl_page_id' );
			wp_safe_redirect( $id ? get_permalink( $id ) : home_url( '/' ) );
			exit;
		}
	}
}
