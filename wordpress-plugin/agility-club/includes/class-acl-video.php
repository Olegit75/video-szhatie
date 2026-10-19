<?php
/**
 * Приём видео из Android-приложения «Сжатие видео».
 *
 * Видео приходят частями (по несколько МБ) — так обходятся ограничения хостинга
 * на размер одного запроса. Файлы лежат в wp-content/uploads/agility-videos/ГГГГ-ММ-ДД/
 * и показываются на вкладке «Видео» встроенным плеером.
 *
 * Вход приложения — «пароль приложения» WordPress (Профиль → Пароли приложений).
 * Загружать могут только администраторы клуба (право acl_manage).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_Video {

	const DIR       = 'agility-videos';
	const MAX_CHUNK = 16777216;   // 16 МБ на часть — с запасом
	const MAX_FILE  = 2147483648; // 2 ГБ на видео

	public static function register() {
		$admin = array( 'ACL_API', 'can_manage' );

		register_rest_route( ACL_API::NS, '/me', array(
			'methods'             => 'GET',
			'callback'            => array( __CLASS__, 'me' ),
			'permission_callback' => '__return_true',
		) );
		register_rest_route( ACL_API::NS, '/video/chunk', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'chunk' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( ACL_API::NS, '/video/(?P<id>\d+)/me', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'toggle_me' ),
			'permission_callback' => 'is_user_logged_in',
		) );
		register_rest_route( ACL_API::NS, '/video/(?P<id>\d+)/fav', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'toggle_fav' ),
			'permission_callback' => 'is_user_logged_in',
		) );
		register_rest_route( ACL_API::NS, '/video/(?P<id>\d+)/delete', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'delete_own' ),
			'permission_callback' => 'is_user_logged_in',
		) );
		register_rest_route( ACL_API::NS, '/video/delete-date', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'delete_date' ),
			'permission_callback' => $admin,
		) );
	}

	/**
	 * Хостинг иногда не передаёт PHP заголовок Authorization. Приложение дублирует
	 * логин и пароль приложения в X-Agility-Auth — подставляем их до проверки ядром WordPress.
	 */
	public static function early_auth() {
		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) || empty( $_SERVER['HTTP_X_AGILITY_AUTH'] ) ) {
			return;
		}
		$raw = base64_decode( (string) wp_unslash( $_SERVER['HTTP_X_AGILITY_AUTH'] ), true ); // phpcs:ignore
		if ( false === $raw || false === strpos( $raw, ':' ) ) {
			return;
		}
		list( $login, $pass )     = explode( ':', $raw, 2 );
		$_SERVER['PHP_AUTH_USER'] = $login;
		$_SERVER['PHP_AUTH_PW']   = $pass;
	}

	/** Запрос к API клуба — признаём его API-запросом, даже если пользователь определяется раньше REST_REQUEST. */
	public static function is_club_api_request() {
		$route = isset( $_GET['rest_route'] ) ? (string) wp_unslash( $_GET['rest_route'] ) : ''; // phpcs:ignore
		$uri   = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore
		return 0 === strpos( $route, '/agility/v1' ) || false !== strpos( $uri, '/wp-json/agility/v1' );
	}

	/** Что видел сервер при последней попытке входа приложения (без пароля) — для диагностики. */
	private static $auth_log = null;

	/**
	 * Только запоминает данные. Писать в базу здесь нельзя: запись может снова вызвать
	 * определение пользователя и зациклить запрос. Сохраняем в конце запроса (shutdown).
	 */
	public static function log_auth( $user ) {
		if ( null !== self::$auth_log || ! self::is_club_api_request() ) {
			return $user;
		}
		$seen = ! empty( $_SERVER['HTTP_AUTHORIZATION'] ) || ! empty( $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ) ? 'authorization' : '';
		if ( ! empty( $_SERVER['HTTP_X_AGILITY_AUTH'] ) ) {
			$seen .= ( $seen ? '+' : '' ) . 'x-agility';
		}
		if ( '' === $seen ) {
			return $user;
		}
		global $wp_rest_application_password_status;
		$status         = $wp_rest_application_password_status;
		self::$auth_log = array(
			'time'   => gmdate( 'Y-m-d H:i:s' ),
			'seen'   => $seen,
			'login'  => isset( $_SERVER['PHP_AUTH_USER'] ) ? substr( preg_replace( '/[^A-Za-z0-9_.@-]/', '', (string) $_SERVER['PHP_AUTH_USER'] ), 0, 60 ) : '', // phpcs:ignore
			'user'   => is_object( $user ) ? (int) $user->ID : (int) $user,
			'status' => is_wp_error( $status ) ? $status->get_error_code() : ( true === $status ? 'ok' : '' ),
			'pw_len' => isset( $_SERVER['PHP_AUTH_PW'] ) ? strlen( preg_replace( '/[^a-z\d]/i', '', (string) $_SERVER['PHP_AUTH_PW'] ) ) : 0, // phpcs:ignore
		);
		add_action( 'shutdown', array( __CLASS__, 'save_auth_log' ) );
		return $user;
	}

	public static function save_auth_log() {
		if ( is_array( self::$auth_log ) ) {
			update_option( 'acl_last_auth', self::$auth_log, false );
		}
	}

	public static function me() {
		$u = wp_get_current_user();
		if ( current_user_can( ACL_CAP ) && isset( $_GET['diag'] ) ) { // phpcs:ignore
			return rest_ensure_response( get_option( 'acl_last_auth', array() ) );
		}
		return rest_ensure_response( array(
			'logged_in'  => (bool) $u->ID,
			'name'       => $u->ID ? $u->display_name : '',
			'can_upload' => current_user_can( ACL_CAP ),
			'max_chunk'  => self::MAX_CHUNK,
		) );
	}

	private static function base() {
		$up = wp_upload_dir();
		return array(
			'dir' => trailingslashit( $up['basedir'] ) . self::DIR,
			'url' => trailingslashit( $up['baseurl'] ) . self::DIR,
		);
	}

	private static function ensure_dirs() {
		$b   = self::base();
		$tmp = $b['dir'] . '/.tmp';
		wp_mkdir_p( $tmp );
		if ( ! file_exists( $b['dir'] . '/index.php' ) ) {
			file_put_contents( $b['dir'] . '/index.php', "<?php\n// Silence is golden.\n" ); // phpcs:ignore
		}
		if ( ! file_exists( $tmp . '/.htaccess' ) ) {
			file_put_contents( $tmp . '/.htaccess', "Require all denied\nDeny from all\n" ); // phpcs:ignore
		}
		return $b;
	}

	private static function err( $msg, $status = 400, $extra = array() ) {
		return new WP_Error( 'acl_video', $msg, array_merge( array( 'status' => $status ), $extra ) );
	}

	/**
	 * Одна часть файла. Параметры в адресе: upload_id, index (с 0), total, name, date, title.
	 * Тело запроса — сырые байты части. Повтор уже принятой части безопасен.
	 */
	public static function chunk( WP_REST_Request $r ) {
		$id    = preg_replace( '/[^A-Za-z0-9_-]/', '', (string) $r['upload_id'] );
		$index = (int) $r['index'];
		$total = (int) $r['total'];
		$date  = (string) $r['date'];
		if ( strlen( $id ) < 8 || $total < 1 || $index < 0 || $index >= $total ) {
			return self::err( 'Неверные параметры загрузки.' );
		}
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date ) ) {
			return self::err( 'Неверная дата.' );
		}
		$body = $r->get_body();
		$len  = strlen( $body );
		if ( 0 === $len || $len > self::MAX_CHUNK ) {
			return self::err( 'Пустая или слишком большая часть файла.' );
		}

		$b     = self::ensure_dirs();
		$part  = $b['dir'] . '/.tmp/' . $id . '.part';
		$key   = 'acl_up_' . $id;
		$next  = (int) get_transient( $key );

		if ( 0 === $index ) {
			$next = 0;
			if ( file_exists( $part ) ) {
				unlink( $part ); // phpcs:ignore
			}
		}
		if ( $index < $next ) {
			return rest_ensure_response( array( 'ok' => true, 'next' => $next, 'duplicate' => true ) );
		}
		if ( $index > $next ) {
			return self::err( 'Пропущена часть файла.', 409, array( 'next' => $next ) );
		}
		if ( ( file_exists( $part ) ? filesize( $part ) : 0 ) + $len > self::MAX_FILE ) {
			return self::err( 'Видео больше 2 ГБ.' );
		}
		if ( false === file_put_contents( $part, $body, FILE_APPEND | LOCK_EX ) ) { // phpcs:ignore
			return self::err( 'Не удалось записать файл на хостинге (закончилось место?).', 500 );
		}
		$next = $index + 1;
		set_transient( $key, $next, DAY_IN_SECONDS );

		if ( $next < $total ) {
			return rest_ensure_response( array( 'ok' => true, 'next' => $next ) );
		}

		// Последняя часть — переносим файл на место и добавляем в список видео.
		delete_transient( $key );
		$dir = $b['dir'] . '/' . $date;
		wp_mkdir_p( $dir );
		$name = sanitize_file_name( (string) $r['name'] );
		if ( '' === $name || ! preg_match( '/\.mp4$/i', $name ) ) {
			$name = 'video-' . $id . '.mp4';
		}
		$name = wp_unique_filename( $dir, $name );
		if ( ! rename( $part, $dir . '/' . $name ) ) { // phpcs:ignore
			return self::err( 'Не удалось сохранить видео.', 500 );
		}
		$size  = filesize( $dir . '/' . $name );
		$title = sanitize_text_field( (string) $r['title'] );
		if ( '' === $title ) {
			$title = 'Тренировка ' . date_i18n( 'j F', strtotime( $date ) );
		}

		global $wpdb;
		$wpdb->insert( ACL_DB::t( 'videos' ), array(
			'date'  => $date,
			'title' => $title,
			'url'   => $b['url'] . '/' . $date . '/' . rawurlencode( $name ),
			'file'  => self::DIR . '/' . $date . '/' . $name,
			'size'  => $size,
		) );
		return rest_ensure_response( array( 'ok' => true, 'done' => true, 'id' => (int) $wpdb->insert_id, 'size' => $size ) );
	}

	/** Удаляет запись и файл (если видео хранится на сайте). */
	public static function delete_row( $id ) {
		global $wpdb;
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT file FROM ' . ACL_DB::t( 'videos' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( $row && $row->file && 0 === strpos( $row->file, self::DIR . '/' ) && false === strpos( $row->file, '..' ) ) {
			$up   = wp_upload_dir();
			$path = trailingslashit( $up['basedir'] ) . $row->file;
			if ( file_exists( $path ) ) {
				unlink( $path ); // phpcs:ignore
			}
			$dir = dirname( $path );
			if ( is_dir( $dir ) && count( (array) scandir( $dir ) ) <= 2 ) {
				rmdir( $dir ); // phpcs:ignore
			}
		}
		$wpdb->delete( ACL_DB::t( 'videos' ), array( 'id' => (int) $id ) );
		$wpdb->delete( ACL_DB::t( 'video_tags' ), array( 'video_id' => (int) $id ) );
	}

	/** «Это я»: отметить себя на видео или снять отметку. */
	public static function toggle_me( WP_REST_Request $r ) {
		global $wpdb;
		$id  = (int) $r['id'];
		$uid = get_current_user_id();
		if ( ! $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . ACL_DB::t( 'videos' ) . ' WHERE id = %d', $id ) ) ) { // phpcs:ignore
			return self::err( 'Видео не найдено.', 404 );
		}
		$t      = ACL_DB::t( 'video_tags' );
		$exists = $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM $t WHERE video_id = %d AND user_id = %d", $id, $uid ) ); // phpcs:ignore
		if ( $exists ) {
			$wpdb->delete( $t, array( 'video_id' => $id, 'user_id' => $uid ) );
		} else {
			$wpdb->insert( $t, array( 'video_id' => $id, 'user_id' => $uid, 'created' => current_time( 'mysql' ) ) );
		}
		return ACL_API::state();
	}

	/** «Избранное»: только на своих видео (где стоит «Это я»). */
	public static function toggle_fav( WP_REST_Request $r ) {
		global $wpdb;
		$id  = (int) $r['id'];
		$uid = get_current_user_id();
		$t   = ACL_DB::t( 'video_tags' );
		$fav = $wpdb->get_var( $wpdb->prepare( "SELECT fav FROM $t WHERE video_id = %d AND user_id = %d", $id, $uid ) ); // phpcs:ignore
		if ( null === $fav ) {
			return self::err( 'Сначала отметьте себя на видео кнопкой «Это я».', 403 );
		}
		$wpdb->update( $t, array( 'fav' => (int) $fav ? 0 : 1 ), array( 'video_id' => $id, 'user_id' => $uid ) );
		return ACL_API::state();
	}

	/**
	 * «Удалить» у участника — это пометка: видео сотрётся через N дней (по умолчанию 30).
	 * Пока срок не вышел, пометку может снять любой отметивший себя «Это я» или администратор.
	 * Ставить пометку может только тот, кто отметил себя на видео, или администратор.
	 */
	public static function delete_own( WP_REST_Request $r ) {
		global $wpdb;
		$id  = (int) $r['id'];
		$uid = get_current_user_id();
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT id, delete_after FROM ' . ACL_DB::t( 'videos' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( ! $row ) {
			return self::err( 'Видео не найдено.', 404 );
		}
		if ( ! current_user_can( ACL_CAP ) ) {
			$ids = array_map( 'intval', (array) $wpdb->get_col( $wpdb->prepare( 'SELECT user_id FROM ' . ACL_DB::t( 'video_tags' ) . ' WHERE video_id = %d', $id ) ) ); // phpcs:ignore
			if ( ! in_array( $uid, $ids, true ) ) {
				return self::err( 'Сначала отметьте себя на видео кнопкой «Это я».', 403 );
			}
		}
		if ( $row->delete_after ) {
			$wpdb->update( ACL_DB::t( 'videos' ), array( 'delete_after' => null, 'delete_by' => null ), array( 'id' => $id ) );
		} else {
			$days = max( 1, (int) ACL_DB::settings()['video_days'] );
			$wpdb->update( ACL_DB::t( 'videos' ), array(
				'delete_after' => gmdate( 'Y-m-d', strtotime( current_time( 'Y-m-d' ) ) + $days * DAY_IN_SECONDS ),
				'delete_by'    => $uid,
			), array( 'id' => $id ) );
		}
		return ACL_API::state();
	}

	/** Раз в сутки стирает видео, у которых истёк срок пометки «Удалить». Непомеченные не трогает. */
	public static function cleanup() {
		global $wpdb;
		$ids = $wpdb->get_col( $wpdb->prepare( 'SELECT id FROM ' . ACL_DB::t( 'videos' ) . ' WHERE delete_after IS NOT NULL AND delete_after <= %s', current_time( 'Y-m-d' ) ) ); // phpcs:ignore
		foreach ( $ids as $vid ) {
			self::delete_row( (int) $vid );
		}
		return count( $ids );
	}

	public static function schedule() {
		if ( ! wp_next_scheduled( 'acl_video_cleanup' ) ) {
			wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'acl_video_cleanup' );
		}
	}

	public static function delete_date( WP_REST_Request $r ) {
		global $wpdb;
		$date = (string) $r['date'];
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date ) ) {
			return self::err( 'Неверная дата.' );
		}
		$ids = $wpdb->get_col( $wpdb->prepare( 'SELECT id FROM ' . ACL_DB::t( 'videos' ) . ' WHERE date = %s', $date ) ); // phpcs:ignore
		foreach ( $ids as $id ) {
			self::delete_row( (int) $id );
		}
		return ACL_API::state();
	}
}

// Подстановка логина из X-Agility-Auth должна случиться раньше проверки паролей приложений ядром.
add_filter( 'determine_current_user', static function ( $user ) {
	ACL_Video::early_auth();
	return $user;
}, 5 );
add_filter( 'determine_current_user', array( 'ACL_Video', 'log_auth' ), 99 );
add_filter( 'application_password_is_api_request', static function ( $is ) {
	return $is || ACL_Video::is_club_api_request();
} );
add_action( 'acl_video_cleanup', array( 'ACL_Video', 'cleanup' ) );
add_action( 'init', array( 'ACL_Video', 'schedule' ) );
