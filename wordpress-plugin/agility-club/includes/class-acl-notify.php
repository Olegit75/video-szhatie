<?php
/**
 * Письма зарегистрированным пользователям о новых тренировках и трассах.
 *
 * Новые записи копятся в очереди и уходят одним письмом через 2 минуты —
 * если администратор добавил сразу несколько тренировок, придёт одно письмо, а не пять.
 * Каждый может отписаться: ссылкой из письма или галочкой на сайте.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_Notify {

	const QUEUE = 'acl_notify_queue';
	const HOOK  = 'acl_notify_flush';
	const OFF   = 'acl_mail_off'; // user meta: 1 — не присылать письма
	const DELAY = 120;

	public static function init() {
		add_action( self::HOOK, array( __CLASS__, 'flush' ) );
	}

	public static function register() {
		register_rest_route( ACL_API::NS, '/notify', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'set_pref' ),
			'permission_callback' => 'is_user_logged_in',
		) );
		register_rest_route( ACL_API::NS, '/notify/send', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'send_now' ),
			'permission_callback' => array( 'ACL_API', 'can_manage' ),
		) );
		register_rest_route( ACL_API::NS, '/unsubscribe', array(
			'methods'             => 'GET',
			'callback'            => array( __CLASS__, 'unsubscribe' ),
			'permission_callback' => '__return_true',
		) );
	}

	public static function enabled() {
		$s = ACL_DB::settings();
		return ! isset( $s['notify'] ) || (int) $s['notify'];
	}

	/** Поставить в очередь: $type = session | course. */
	public static function queue( $type, $id ) {
		if ( ! $id || ! self::enabled() ) {
			return;
		}
		$q   = (array) get_option( self::QUEUE, array() );
		$q[] = array( 'type' => $type, 'id' => (int) $id, 'by' => get_current_user_id() );
		update_option( self::QUEUE, $q, false );
		if ( ! wp_next_scheduled( self::HOOK ) ) {
			wp_schedule_single_event( time() + self::DELAY, self::HOOK );
		}
	}

	/** Собрать очередь в письмо и разослать. */
	public static function flush() {
		global $wpdb;
		$q = (array) get_option( self::QUEUE, array() );
		delete_option( self::QUEUE );
		if ( ! $q || ! self::enabled() ) {
			return 0;
		}
		$today    = current_time( 'Y-m-d' );
		$sessions = array();
		$courses  = array();
		$seen     = array();
		foreach ( $q as $it ) {
			$key = $it['type'] . $it['id'];
			if ( isset( $seen[ $key ] ) ) {
				continue;
			}
			$seen[ $key ] = true;
			if ( 'session' === $it['type'] ) {
				$s = $wpdb->get_row( $wpdb->prepare( 'SELECT id, date, start, hours FROM ' . ACL_DB::t( 'sessions' ) . ' WHERE id = %d', $it['id'] ), ARRAY_A ); // phpcs:ignore
				if ( $s && $s['date'] >= $today ) {
					$s['by']    = (int) $it['by'];
					$sessions[] = $s;
				}
			} elseif ( 'course' === $it['type'] ) {
				$c = $wpdb->get_row( $wpdb->prepare( 'SELECT c.id, c.title, c.note, c.image, c.length_m, c.user_id, c.session_id, s.date, s.start FROM ' . ACL_DB::t( 'courses' ) . ' c JOIN ' . ACL_DB::t( 'sessions' ) . ' s ON s.id = c.session_id WHERE c.id = %d', $it['id'] ), ARRAY_A ); // phpcs:ignore
				if ( $c && $c['date'] >= $today ) {
					$c['by']   = (int) $it['by'];
					$courses[] = $c;
				}
			}
		}
		if ( ! $sessions && ! $courses ) {
			return 0;
		}
		usort( $sessions, static function ( $a, $b ) {
			return strcmp( $a['date'] . $a['start'], $b['date'] . $b['start'] );
		} );

		$sent  = 0;
		$users = get_users( array( 'fields' => array( 'ID', 'user_email', 'display_name' ) ) );
		if ( function_exists( 'set_time_limit' ) ) {
			@set_time_limit( 120 ); // phpcs:ignore
		}
		foreach ( $users as $u ) {
			$uid = (int) $u->ID;
			if ( ! is_email( $u->user_email ) || get_user_meta( $uid, self::OFF, true ) ) {
				continue;
			}
			// Автору не пишем о его же записях
			$ms = array_values( array_filter( $sessions, static function ( $x ) use ( $uid ) { return $x['by'] !== $uid; } ) );
			$mc = array_values( array_filter( $courses, static function ( $x ) use ( $uid ) { return $x['by'] !== $uid; } ) );
			if ( ! $ms && ! $mc ) {
				continue;
			}
			list( $subject, $html ) = self::compose( $ms, $mc, $uid );
			if ( wp_mail( $u->user_email, $subject, $html, array( 'Content-Type: text/html; charset=UTF-8' ) ) ) {
				$sent++;
			}
		}
		update_option( 'acl_notify_last', array( 'time' => current_time( 'mysql' ), 'sent' => $sent ), false );
		return $sent;
	}

	private static function date_ru( $d, $start = '' ) {
		$days   = array( 'вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб' );
		$months = array( '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря' );
		$t      = strtotime( $d );
		return $days[ (int) gmdate( 'w', $t ) ] . ', ' . (int) gmdate( 'j', $t ) . ' ' . $months[ (int) gmdate( 'n', $t ) ] . ( $start ? ' в ' . $start : '' );
	}

	private static function who( $uid ) {
		foreach ( ACL_DB::members( false ) as $m ) {
			if ( (int) $m['user_id'] === (int) $uid ) {
				return $m['name'];
			}
		}
		$ud = get_userdata( $uid );
		return $ud ? $ud->display_name : '';
	}

	private static function hours_ru( $h ) {
		$h = (float) $h;
		$s = rtrim( rtrim( number_format( $h, 1, ',', '' ), '0' ), ',' );
		return $s . ' ч';
	}

	private static function compose( array $sessions, array $courses, $uid ) {
		$site = home_url( '/' );
		$e    = static function ( $s ) { return esc_html( $s ); };
		if ( count( $sessions ) + count( $courses ) === 1 ) {
			$subject = $sessions
				? 'Новая тренировка: ' . self::date_ru( $sessions[0]['date'], $sessions[0]['start'] )
				: 'Новая трасса «' . $courses[0]['title'] . '» на ' . self::date_ru( $courses[0]['date'] );
		} else {
			$parts = array();
			if ( $sessions ) {
				$parts[] = count( $sessions ) . ' ' . self::plural( count( $sessions ), 'тренировка', 'тренировки', 'тренировок' );
			}
			if ( $courses ) {
				$parts[] = count( $courses ) . ' ' . self::plural( count( $courses ), 'трасса', 'трассы', 'трасс' );
			}
			$subject = 'Новое в расписании: ' . implode( ', ', $parts );
		}
		$subject = 'Аджилити-клуб · ' . $subject;

		$h  = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a2233;max-width:560px">';
		if ( $sessions ) {
			$h .= '<h2 style="font-size:18px;margin:0 0 8px">' . ( count( $sessions ) > 1 ? 'Новые тренировки' : 'Новая тренировка' ) . '</h2><ul style="padding-left:20px;margin:0 0 16px">';
			foreach ( $sessions as $s ) {
				$h .= '<li><a href="' . esc_url( $site . '#schedule' ) . '">' . $e( self::date_ru( $s['date'], $s['start'] ) ) . '</a>, ' . $e( self::hours_ru( $s['hours'] ) ) . '</li>';
			}
			$h .= '</ul><p style="margin:0 0 16px">Отметить участие можно на сайте во вкладке «Мои тренировки».</p>';
		}
		if ( $courses ) {
			$h .= '<h2 style="font-size:18px;margin:0 0 8px">' . ( count( $courses ) > 1 ? 'Новые трассы' : 'Новая трасса' ) . '</h2>';
			foreach ( $courses as $c ) {
				$link = $site . '#courses-' . $c['session_id'];
				$h   .= '<div style="margin:0 0 16px;padding:10px 12px;border:1px solid #dde3ee;border-radius:8px">' .
					'<b><a href="' . esc_url( $link ) . '">' . $e( $c['title'] ) . '</a></b>' .
					'<div style="color:#5b6577;font-size:13px">' . $e( self::date_ru( $c['date'], $c['start'] ) ) .
					( null !== $c['length_m'] ? ' · ' . $e( str_replace( '.', ',', rtrim( rtrim( $c['length_m'], '0' ), '.' ) ) ) . ' м' : '' ) .
					( self::who( $c['user_id'] ) ? ' · предложил(а): ' . $e( self::who( $c['user_id'] ) ) : '' ) . '</div>' .
					( $c['note'] ? '<p style="margin:6px 0 0;white-space:pre-wrap">' . $e( $c['note'] ) . '</p>' : '' ) .
					( $c['image'] ? '<a href="' . esc_url( $link ) . '"><img src="' . esc_url( trailingslashit( wp_upload_dir()['baseurl'] ) . $c['image'] ) . '" alt="Схема трассы" style="display:block;max-width:100%;margin-top:8px;border-radius:6px"></a>' : '' ) .
					'<p style="margin:8px 0 0"><a href="' . esc_url( $link ) . '">Посмотреть и проголосовать →</a></p></div>';
			}
		}
		$h .= '<p style="margin:24px 0 0;color:#8a93a3;font-size:12px">Вы получили это письмо как зарегистрированный пользователь сайта <a href="' . esc_url( $site ) . '" style="color:#8a93a3">' . $e( wp_parse_url( $site, PHP_URL_HOST ) ) . '</a>. ' .
			'<a href="' . esc_url( self::unsub_url( $uid ) ) . '" style="color:#8a93a3">Не присылать такие письма</a>.</p></div>';
		return array( $subject, $h );
	}

	private static function plural( $n, $one, $few, $many ) {
		$m10  = $n % 10;
		$m100 = $n % 100;
		if ( 1 === $m10 && 11 !== $m100 ) {
			return $one;
		}
		if ( $m10 >= 2 && $m10 <= 4 && ( $m100 < 12 || $m100 > 14 ) ) {
			return $few;
		}
		return $many;
	}

	private static function token( $uid ) {
		return substr( wp_hash( 'acl-unsub-' . (int) $uid ), 0, 20 );
	}

	public static function unsub_url( $uid ) {
		return add_query_arg( array(
			'rest_route' => '/' . ACL_API::NS . '/unsubscribe',
			'u'          => (int) $uid,
			'k'          => self::token( $uid ),
		), home_url( '/' ) );
	}

	/** Отписка по ссылке из письма — без входа на сайт. */
	public static function unsubscribe( WP_REST_Request $r ) {
		$uid = (int) $r['u'];
		$ok  = $uid && get_userdata( $uid ) && hash_equals( self::token( $uid ), (string) $r['k'] );
		if ( $ok ) {
			update_user_meta( $uid, self::OFF, 1 );
		}
		$msg = $ok
			? 'Готово: письма о новых тренировках и трассах больше не придут. Включить их снова можно на сайте во вкладке «Мои тренировки».'
			: 'Ссылка устарела или повреждена. Отключить письма можно на сайте во вкладке «Мои тренировки».';
		header( 'Content-Type: text/html; charset=UTF-8' );
		echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Письма клуба</title>' .
			'<div style="font-family:Arial,sans-serif;max-width:520px;margin:15vh auto;padding:0 16px;font-size:17px;line-height:1.5">' . esc_html( $msg ) .
			'<p><a href="' . esc_url( home_url( '/' ) ) . '">Перейти на сайт</a></p></div>';
		exit;
	}

	/** Ручная рассылка администратором о выбранных тренировках — сразу, без ожидания. */
	public static function send_now( WP_REST_Request $r ) {
		$ids = array_filter( array_map( 'intval', (array) $r['session_ids'] ) );
		if ( ! $ids ) {
			return new WP_Error( 'acl', 'Отметьте тренировки для рассылки.', array( 'status' => 400 ) );
		}
		if ( ! self::enabled() ) {
			return new WP_Error( 'acl', 'Рассылка выключена в настройках.', array( 'status' => 400 ) );
		}
		$q = (array) get_option( self::QUEUE, array() );
		foreach ( $ids as $id ) {
			$q[] = array( 'type' => 'session', 'id' => $id, 'by' => get_current_user_id() );
		}
		update_option( self::QUEUE, $q, false );
		wp_clear_scheduled_hook( self::HOOK );
		self::flush();
		return ACL_API::state();
	}

	/** Галочка на сайте: получать письма или нет. */
	public static function set_pref( WP_REST_Request $r ) {
		$on = filter_var( $r['on'], FILTER_VALIDATE_BOOLEAN );
		if ( $on ) {
			delete_user_meta( get_current_user_id(), self::OFF );
		} else {
			update_user_meta( get_current_user_id(), self::OFF, 1 );
		}
		return ACL_API::state();
	}

	public static function user_on( $uid ) {
		return $uid && ! get_user_meta( $uid, self::OFF, true );
	}
}
