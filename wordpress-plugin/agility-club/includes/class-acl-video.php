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

	public static function me() {
		$u = wp_get_current_user();
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
