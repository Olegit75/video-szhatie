<?php
/**
 * REST API клуба: /wp-json/agility/v1/...
 * Каждая роль получает только свои данные; права проверяются здесь, на сервере.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_API {

	const NS = 'agility/v1';

	public static function register() {
		$admin  = array( __CLASS__, 'can_manage' );
		$logged = 'is_user_logged_in';

		register_rest_route( self::NS, '/state', array(
			'methods'             => 'GET',
			'callback'            => array( __CLASS__, 'state' ),
			'permission_callback' => '__return_true',
		) );
		register_rest_route( self::NS, '/mark', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'mark' ),
			'permission_callback' => $logged,
		) );
		register_rest_route( self::NS, '/request', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'request_member' ),
			'permission_callback' => $logged,
		) );
		register_rest_route( self::NS, '/sessions', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'session_save' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/sessions/(?P<id>\d+)', array(
			'methods'             => 'DELETE',
			'callback'            => array( __CLASS__, 'session_delete' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/settings', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'settings_save' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/link', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'link' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/videos', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'video_add' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/videos/(?P<id>\d+)', array(
			'methods'             => 'DELETE',
			'callback'            => array( __CLASS__, 'video_delete' ),
			'permission_callback' => $admin,
		) );
		register_rest_route( self::NS, '/import', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'import' ),
			'permission_callback' => $admin,
		) );
	}

	public static function can_manage() {
		return current_user_can( ACL_CAP );
	}

	private static function my_member( array $members ) {
		$uid = get_current_user_id();
		if ( ! $uid ) {
			return null;
		}
		foreach ( $members as $m ) {
			if ( (int) $m['user_id'] === $uid ) {
				return $m;
			}
		}
		return null;
	}

	private static function role( $me ) {
		if ( self::can_manage() ) {
			return 'admin';
		}
		if ( $me ) {
			return 'member';
		}
		return is_user_logged_in() ? 'pending' : 'guest';
	}

	private static function err( $msg, $status = 400 ) {
		return new WP_Error( 'acl_error', $msg, array( 'status' => $status ) );
	}

	/* ---------------- state ---------------- */

	public static function state() {
		$cfg      = ACL_DB::settings();
		$members  = ACL_DB::members();
		$me       = self::my_member( $members );
		$role     = self::role( $me );
		$sessions = ACL_DB::sessions();
		$today    = current_time( 'Y-m-d' );

		$out = array(
			'role'      => $role,
			'today'     => $today,
			'user'      => is_user_logged_in() ? wp_get_current_user()->display_name : '',
			'links'     => array(
				'login'    => wp_login_url( self::app_url() ),
				'logout'   => wp_logout_url( self::app_url() ),
				'register' => get_option( 'users_can_register' ) ? wp_registration_url() : '',
				'newPost'  => 'admin' === $role ? admin_url( 'post-new.php' ) : '',
			),
			'news'      => self::news(),
			'videos'    => ACL_DB::videos( get_current_user_id(), is_user_logged_in() ),
			'video_days' => (int) $cfg['video_days'],
			'sessions'  => array(),
		);

		if ( 'guest' === $role || 'pending' === $role ) {
			foreach ( $sessions as $s ) {
				if ( $s['date'] >= $today ) {
					$out['sessions'][] = $s;
				}
			}
			if ( 'pending' === $role ) {
				$out['members'] = array_values( array_map(
					static function ( $m ) {
						return array( 'id' => $m['id'], 'name' => $m['name'] );
					},
					array_filter( $members, static function ( $m ) {
						return ! $m['is_organizer'] && ! $m['user_id'];
					} )
				) );
				$out['request'] = (int) get_user_meta( get_current_user_id(), 'acl_request', true );
			}
			return rest_ensure_response( $out );
		}

		$marks = ACL_DB::marks();
		$out['settings'] = $cfg;
		$out['members']  = array_map(
			static function ( $m ) use ( $role ) {
				$x = array( 'id' => $m['id'], 'name' => $m['name'], 'is_organizer' => $m['is_organizer'] );
				if ( 'admin' === $role ) {
					$x['user_id'] = $m['user_id'];
				}
				return $x;
			},
			$members
		);

		foreach ( $sessions as $s ) {
			$sm = isset( $marks[ $s['id'] ] ) ? $marks[ $s['id'] ] : array();
			$c  = ACL_Calc::session( $s, $members, $sm, $cfg );
			$row = $s + array(
				'n'      => $c['n'],
				'shares' => $c['shares'],
				'per'    => $c['per'],
				'org_in' => $c['org_in'],
				'att'    => $c['att'],
			);
			if ( 'admin' === $role ) {
				$row['rent']    = $c['rent'];
				$row['org']     = $c['org'];
				$row['per_dog'] = $c['per_dog'];
				$row['marks']   = (object) $sm;
			} else {
				$row['my'] = isset( $sm[ $me['id'] ] ) ? $sm[ $me['id'] ] : '';
			}
			$out['sessions'][] = $row;
		}

		$out['courses'] = ACL_Course::all();
		if ( 'member' === $role ) {
			$out['me'] = array( 'id' => $me['id'], 'name' => $me['name'] );
		}
		if ( 'admin' === $role ) {
			$out['accounts'] = self::accounts( $members );
		}
		return rest_ensure_response( $out );
	}

	private static function app_url() {
		$id = (int) get_option( 'acl_page_id' );
		return $id ? get_permalink( $id ) : home_url( '/' );
	}

	private static function news() {
		$posts = get_posts( array( 'numberposts' => 20, 'post_status' => 'publish', 'post_type' => 'post' ) );
		return array_map(
			static function ( $p ) {
				return array(
					'id'    => $p->ID,
					'date'  => get_the_date( 'Y-m-d', $p ),
					'title' => get_the_title( $p ),
					'html'  => wp_kses_post( wpautop( strip_shortcodes( $p->post_content ) ) ),
					'link'  => get_permalink( $p ),
				);
			},
			$posts
		);
	}

	/** Аккаунты, которые подали заявку или уже привязаны. */
	private static function accounts( array $members ) {
		$ids = array();
		foreach ( $members as $m ) {
			if ( $m['user_id'] ) {
				$ids[ $m['user_id'] ] = true;
			}
		}
		$req = get_users( array( 'meta_key' => 'acl_request', 'fields' => 'ID' ) );
		foreach ( $req as $id ) {
			$ids[ (int) $id ] = true;
		}
		$out = array();
		foreach ( array_keys( $ids ) as $id ) {
			$u = get_userdata( $id );
			if ( ! $u ) {
				continue;
			}
			$linked = null;
			foreach ( $members as $m ) {
				if ( (int) $m['user_id'] === (int) $id ) {
					$linked = $m['id'];
				}
			}
			$out[] = array(
				'user_id' => (int) $id,
				'name'    => $u->display_name,
				'login'   => $u->user_login,
				'email'   => $u->user_email,
				'request' => (int) get_user_meta( $id, 'acl_request', true ),
				'linked'  => $linked,
			);
		}
		return $out;
	}

	/* ---------------- marks ---------------- */

	public static function mark( WP_REST_Request $r ) {
		global $wpdb;
		$sid  = (int) $r['session_id'];
		$mid  = (int) $r['member_id'];
		$mark = (string) $r['mark'];

		$exists = $wpdb->get_var( $wpdb->prepare( 'SELECT id FROM ' . ACL_DB::t( 'sessions' ) . ' WHERE id = %d', $sid ) ); // phpcs:ignore
		if ( ! $exists ) {
			return self::err( 'Тренировка не найдена.', 404 );
		}
		$members = ACL_DB::members();
		$target  = null;
		foreach ( $members as $m ) {
			if ( $m['id'] === $mid ) {
				$target = $m;
			}
		}
		if ( ! $target ) {
			return self::err( 'Участник не найден.', 404 );
		}
		if ( ! self::can_manage() ) {
			$me = self::my_member( $members );
			if ( ! $me || $me['id'] !== $mid ) {
				return self::err( 'Можно отмечать только себя.', 403 );
			}
		}
		if ( $target['is_organizer'] && '' !== ACL_DB::norm( $mark ) ) {
			$mark = 'Да';
		}
		ACL_DB::set_mark( $sid, $mid, $mark );
		return self::state();
	}

	public static function request_member( WP_REST_Request $r ) {
		$mid = (int) $r['member_id'];
		foreach ( ACL_DB::members() as $m ) {
			if ( $m['id'] === $mid && ! $m['is_organizer'] && ! $m['user_id'] ) {
				update_user_meta( get_current_user_id(), 'acl_request', $mid );
				return self::state();
			}
		}
		return self::err( 'Этого участника нельзя выбрать.' );
	}

	/* ---------------- admin ---------------- */

	public static function session_save( WP_REST_Request $r ) {
		global $wpdb;
		$date = sanitize_text_field( (string) $r['date'] );
		$start = sanitize_text_field( (string) $r['start'] );
		$hours = (float) $r['hours'];
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date ) ) {
			return self::err( 'Укажите дату.' );
		}
		if ( '' !== $start && ! preg_match( '/^\d{2}:\d{2}$/', $start ) ) {
			return self::err( 'Время в формате ЧЧ:ММ.' );
		}
		if ( $hours <= 0 || $hours > 12 ) {
			return self::err( 'Часы от 0,5 до 12.' );
		}
		$data = array( 'date' => $date, 'start' => $start, 'hours' => $hours );
		$id   = (int) $r['id'];
		if ( $id ) {
			$wpdb->update( ACL_DB::t( 'sessions' ), $data, array( 'id' => $id ) );
		} else {
			$wpdb->insert( ACL_DB::t( 'sessions' ), $data );
		}
		return self::state();
	}

	public static function session_delete( WP_REST_Request $r ) {
		global $wpdb;
		$id = (int) $r['id'];
		$wpdb->delete( ACL_DB::t( 'sessions' ), array( 'id' => $id ) );
		$wpdb->delete( ACL_DB::t( 'marks' ), array( 'session_id' => $id ) );
		ACL_Course::delete_for_session( $id );
		return self::state();
	}

	public static function settings_save( WP_REST_Request $r ) {
		global $wpdb;
		$s = ACL_DB::settings();
		foreach ( array( 'rate', 'free_hours', 'setup_min', 'cleanup_min', 'org_shares', 'org_discount', 'video_days' ) as $k ) {
			if ( isset( $r[ $k ] ) && is_numeric( $r[ $k ] ) ) {
				$s[ $k ] = max( 0, (float) $r[ $k ] );
			}
		}
		update_option( 'acl_settings', $s );

		// Участники: список имён по порядку; организатор — отдельным полем.
		if ( is_array( $r['members'] ) ) {
			$t        = ACL_DB::t( 'members' );
			$existing = ACL_DB::members( false );
			$keep     = array();
			$org_name = sanitize_text_field( (string) $r['organizer'] );
			foreach ( $existing as $m ) {
				if ( $m['is_organizer'] ) {
					if ( '' !== $org_name ) {
						$wpdb->update( $t, array( 'name' => $org_name, 'active' => 1 ), array( 'id' => $m['id'] ) );
					}
					$keep[ $m['id'] ] = true;
					$org_name         = '';
				}
			}
			if ( '' !== $org_name ) {
				$wpdb->insert( $t, array( 'name' => $org_name, 'is_organizer' => 1 ) );
				$keep[ $wpdb->insert_id ] = true;
			}
			$sort = 0;
			foreach ( $r['members'] as $item ) {
				$name = sanitize_text_field( (string) ( is_array( $item ) ? ( $item['name'] ?? '' ) : $item ) );
				$id   = is_array( $item ) ? (int) ( $item['id'] ?? 0 ) : 0;
				if ( '' === $name ) {
					continue;
				}
				$sort++;
				$match = null;
				foreach ( $existing as $m ) {
					if ( ! $m['is_organizer'] && empty( $keep[ $m['id'] ] ) && ( ( $id && $m['id'] === $id ) || ( ! $id && $m['name'] === $name ) ) ) {
						$match = $m;
						break;
					}
				}
				if ( $match ) {
					$wpdb->update( $t, array( 'name' => $name, 'sort' => $sort, 'active' => 1 ), array( 'id' => $match['id'] ) );
					$keep[ $match['id'] ] = true;
				} else {
					$wpdb->insert( $t, array( 'name' => $name, 'sort' => $sort ) );
					$keep[ $wpdb->insert_id ] = true;
				}
			}
			// Удалённые из списка скрываются, отметки и история сохраняются.
			foreach ( $existing as $m ) {
				if ( empty( $keep[ $m['id'] ] ) ) {
					$wpdb->update( $t, array( 'active' => 0, 'user_id' => null ), array( 'id' => $m['id'] ) );
				}
			}
		}
		return self::state();
	}

	public static function link( WP_REST_Request $r ) {
		global $wpdb;
		$uid = (int) $r['user_id'];
		$mid = (int) $r['member_id'];
		if ( ! get_userdata( $uid ) ) {
			return self::err( 'Аккаунт не найден.', 404 );
		}
		$t = ACL_DB::t( 'members' );
		$wpdb->query( $wpdb->prepare( "UPDATE $t SET user_id = NULL WHERE user_id = %d", $uid ) ); // phpcs:ignore
		if ( $mid ) {
			$wpdb->update( $t, array( 'user_id' => $uid ), array( 'id' => $mid, 'is_organizer' => 0 ) );
			delete_user_meta( $uid, 'acl_request' );
		}
		return self::state();
	}

	public static function video_add( WP_REST_Request $r ) {
		global $wpdb;
		$url   = esc_url_raw( (string) $r['url'], array( 'http', 'https' ) );
		$title = sanitize_text_field( (string) $r['title'] );
		$date  = sanitize_text_field( (string) $r['date'] );
		if ( ! $url || ! $title ) {
			return self::err( 'Укажите название и ссылку.' );
		}
		if ( ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', $date ) ) {
			$date = current_time( 'Y-m-d' );
		}
		$wpdb->insert( ACL_DB::t( 'videos' ), array( 'date' => $date, 'title' => $title, 'url' => $url ) );
		return self::state();
	}

	public static function video_delete( WP_REST_Request $r ) {
		ACL_Video::delete_row( (int) $r['id'] );
		return self::state();
	}

	/**
	 * Начальный перенос данных: {settings, organizer, members:[{key,name}], sessions:[{date,start,hours,marks:{key:mark}}]}.
	 * Работает только на пустой базе, чтобы случайно не задвоить тренировки.
	 */
	public static function import( WP_REST_Request $r ) {
		global $wpdb;
		$count = (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . ACL_DB::t( 'sessions' ) ); // phpcs:ignore
		if ( $count > 0 ) {
			return self::err( 'Тренировки уже есть, импорт нужен только для пустой базы.' );
		}
		$data = $r->get_json_params();
		if ( empty( $data ) ) {
			$file = ACL_DIR . 'seed.json';
			$data = file_exists( $file ) ? json_decode( (string) file_get_contents( $file ), true ) : null;
		}
		if ( ! is_array( $data ) || empty( $data['sessions'] ) ) {
			return self::err( 'Нет данных для импорта.' );
		}
		if ( ! empty( $data['settings'] ) && is_array( $data['settings'] ) ) {
			update_option( 'acl_settings', wp_parse_args( array_map( 'floatval', $data['settings'] ), ACL_DB::default_settings() ) );
		}
		$t   = ACL_DB::t( 'members' );
		$map = array();
		if ( ! empty( $data['organizer'] ) ) {
			$wpdb->insert( $t, array( 'name' => sanitize_text_field( $data['organizer']['name'] ), 'is_organizer' => 1 ) );
			$map[ $data['organizer']['key'] ] = $wpdb->insert_id;
		}
		$sort = 0;
		foreach ( (array) $data['members'] as $m ) {
			$wpdb->insert( $t, array( 'name' => sanitize_text_field( $m['name'] ), 'sort' => ++$sort ) );
			$map[ $m['key'] ] = $wpdb->insert_id;
		}
		foreach ( $data['sessions'] as $s ) {
			$wpdb->insert( ACL_DB::t( 'sessions' ), array(
				'date'  => sanitize_text_field( $s['date'] ),
				'start' => sanitize_text_field( (string) $s['start'] ),
				'hours' => (float) $s['hours'],
			) );
			$sid = $wpdb->insert_id;
			foreach ( (array) ( $s['marks'] ?? array() ) as $key => $mark ) {
				if ( isset( $map[ $key ] ) ) {
					ACL_DB::set_mark( $sid, $map[ $key ], $mark );
				}
			}
		}
		return self::state();
	}
}
