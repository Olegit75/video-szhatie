<?php
/**
 * Таблицы и настройки клуба.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_DB {

	const DB_VERSION = '7';

	public static function t( $name ) {
		global $wpdb;
		return $wpdb->prefix . 'acl_' . $name;
	}

	public static function activate() {
		self::create_tables();
		foreach ( array( 'administrator', 'editor' ) as $role_name ) {
			$role = get_role( $role_name );
			if ( $role ) {
				$role->add_cap( ACL_CAP );
			}
		}
		if ( false === get_option( 'acl_settings' ) ) {
			add_option( 'acl_settings', self::default_settings() );
		}
	}

	public static function maybe_upgrade() {
		if ( get_option( 'acl_db_version' ) !== self::DB_VERSION ) {
			self::activate();
		}
	}

	public static function create_tables() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$c = $wpdb->get_charset_collate();

		dbDelta(
			'CREATE TABLE ' . self::t( 'members' ) . " (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			name varchar(100) NOT NULL,
			user_id bigint(20) unsigned DEFAULT NULL,
			is_organizer tinyint(1) NOT NULL DEFAULT 0,
			sort int(11) NOT NULL DEFAULT 0,
			active tinyint(1) NOT NULL DEFAULT 1,
			PRIMARY KEY  (id),
			KEY user_id (user_id)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'sessions' ) . " (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			date date NOT NULL,
			start varchar(5) NOT NULL DEFAULT '',
			hours decimal(4,2) NOT NULL DEFAULT 2.00,
			PRIMARY KEY  (id),
			KEY date (date)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'marks' ) . " (
			session_id bigint(20) unsigned NOT NULL,
			member_id bigint(20) unsigned NOT NULL,
			mark varchar(8) NOT NULL DEFAULT '',
			updated_by bigint(20) unsigned DEFAULT NULL,
			updated_at datetime DEFAULT NULL,
			PRIMARY KEY  (session_id,member_id)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'videos' ) . " (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			date date NOT NULL,
			title varchar(200) NOT NULL,
			url varchar(500) NOT NULL,
			file varchar(500) NOT NULL DEFAULT '',
			size bigint(20) unsigned NOT NULL DEFAULT 0,
			delete_after date DEFAULT NULL,
			delete_by bigint(20) unsigned DEFAULT NULL,
			course_id bigint(20) unsigned DEFAULT NULL,
			run_time decimal(7,2) DEFAULT NULL,
			run_pen smallint(5) unsigned NOT NULL DEFAULT 0,
			run_dq tinyint(1) NOT NULL DEFAULT 0,
			PRIMARY KEY  (id),
			KEY date (date)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'video_tags' ) . " (
			video_id bigint(20) unsigned NOT NULL,
			user_id bigint(20) unsigned NOT NULL,
			created datetime DEFAULT NULL,
			fav tinyint(1) NOT NULL DEFAULT 0,
			PRIMARY KEY  (video_id,user_id),
			KEY user_id (user_id)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'courses' ) . " (
			id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
			session_id bigint(20) unsigned NOT NULL,
			user_id bigint(20) unsigned NOT NULL,
			title varchar(200) NOT NULL,
			note text,
			image varchar(500) NOT NULL DEFAULT '',
			length_m decimal(6,1) DEFAULT NULL,
			ran tinyint(1) NOT NULL DEFAULT 0,
			created datetime DEFAULT NULL,
			PRIMARY KEY  (id),
			KEY session_id (session_id)
			) $c;"
		);
		dbDelta(
			'CREATE TABLE ' . self::t( 'course_votes' ) . " (
			course_id bigint(20) unsigned NOT NULL,
			user_id bigint(20) unsigned NOT NULL,
			comment text,
			created datetime DEFAULT NULL,
			PRIMARY KEY  (course_id,user_id)
			) $c;"
		);
		update_option( 'acl_db_version', self::DB_VERSION );
	}

	public static function default_settings() {
		return array(
			'rate'         => 2500,
			'free_hours'   => 1,
			'setup_min'    => 20,
			'cleanup_min'  => 10,
			'org_shares'   => 2,
			'org_discount' => 300,
			'video_days'   => 30,
		);
	}

	public static function settings() {
		$s = get_option( 'acl_settings', array() );
		return wp_parse_args( is_array( $s ) ? $s : array(), self::default_settings() );
	}

	/**
	 * Отметка: О/O/0 (любой регистр) — оплачено, «да» — был, не оплатил, иначе пусто.
	 */
	public static function norm( $v ) {
		$s = mb_strtolower( trim( (string) $v ) );
		if ( '' === $s ) {
			return '';
		}
		if ( in_array( $s, array( 'о', 'o', '0', 'paid' ), true ) ) {
			return 'paid';
		}
		if ( in_array( $s, array( 'да', 'debt', 'yes' ), true ) ) {
			return 'debt';
		}
		return '';
	}

	public static function members( $only_active = true ) {
		global $wpdb;
		$sql = 'SELECT * FROM ' . self::t( 'members' ) . ( $only_active ? ' WHERE active = 1' : '' ) . ' ORDER BY is_organizer DESC, sort ASC, id ASC';
		$rows = $wpdb->get_results( $sql, ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.NotPrepared
		foreach ( $rows as &$r ) {
			$r['id']           = (int) $r['id'];
			$r['user_id']      = $r['user_id'] ? (int) $r['user_id'] : null;
			$r['is_organizer'] = (int) $r['is_organizer'];
			$r['sort']         = (int) $r['sort'];
			$r['active']       = (int) $r['active'];
		}
		return $rows;
	}

	public static function sessions() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT id, date, start, hours FROM ' . self::t( 'sessions' ) . ' ORDER BY date DESC, start DESC', ARRAY_A ); // phpcs:ignore
		foreach ( $rows as &$r ) {
			$r['id']    = (int) $r['id'];
			$r['hours'] = (float) $r['hours'];
		}
		return $rows;
	}

	/** @return array session_id => member_id => 'paid'|'debt' */
	public static function marks() {
		global $wpdb;
		$out  = array();
		$rows = $wpdb->get_results( 'SELECT session_id, member_id, mark FROM ' . self::t( 'marks' ), ARRAY_A ); // phpcs:ignore
		foreach ( $rows as $r ) {
			$n = self::norm( $r['mark'] );
			if ( $n ) {
				$out[ (int) $r['session_id'] ][ (int) $r['member_id'] ] = $n;
			}
		}
		return $out;
	}

	public static function set_mark( $session_id, $member_id, $mark ) {
		global $wpdb;
		$n = self::norm( $mark );
		if ( '' === $n ) {
			return false !== $wpdb->delete( self::t( 'marks' ), array( 'session_id' => $session_id, 'member_id' => $member_id ) );
		}
		return false !== $wpdb->replace(
			self::t( 'marks' ),
			array(
				'session_id' => $session_id,
				'member_id'  => $member_id,
				'mark'       => 'paid' === $n ? 'О' : 'Да',
				'updated_by' => get_current_user_id(),
				'updated_at' => current_time( 'mysql' ),
			)
		);
	}

	/**
	 * Видео с отметками «Это я».
	 * $uid — текущий пользователь (для mine), $names — показывать ли, кто отмечен (только вошедшим).
	 */
	public static function videos( $uid = 0, $names = false ) {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT id, date, title, url, size, (file <> \'\') AS local, delete_after, delete_by, course_id, run_time, run_pen, run_dq FROM ' . self::t( 'videos' ) . ' ORDER BY date DESC, id DESC', ARRAY_A ); // phpcs:ignore
		if ( ! $rows ) {
			return array();
		}
		$tags  = $wpdb->get_results( 'SELECT video_id, user_id, fav FROM ' . self::t( 'video_tags' ), ARRAY_A ); // phpcs:ignore
		$by    = array();
		$users = array();
		$favs  = array();
		foreach ( (array) $tags as $t ) {
			if ( $uid && (int) $t['user_id'] === (int) $uid && (int) $t['fav'] ) {
				$favs[ (int) $t['video_id'] ] = true;
			}
			$by[ (int) $t['video_id'] ][] = (int) $t['user_id'];
			$users[ (int) $t['user_id'] ] = true;
		}
		$label = array();
		if ( $names && $users ) {
			foreach ( self::members( false ) as $m ) {
				if ( $m['user_id'] && isset( $users[ $m['user_id'] ] ) ) {
					$label[ $m['user_id'] ] = $m['name'];
				}
			}
			foreach ( array_keys( $users ) as $u ) {
				if ( ! isset( $label[ $u ] ) ) {
					$ud          = get_userdata( $u );
					$label[ $u ] = $ud ? $ud->display_name : '';
				}
			}
		}
		foreach ( $rows as &$r ) {
			$ids         = isset( $by[ (int) $r['id'] ] ) ? $by[ (int) $r['id'] ] : array();
			$r['mine']   = $uid && in_array( (int) $uid, $ids, true );
			// Пометить «Удалить» (или снять пометку) может отметивший себя «Это я» участник или администратор
			$r['can_mark'] = current_user_can( ACL_CAP ) || ( $uid && in_array( (int) $uid, $ids, true ) );
			$r['marked']   = ! empty( $r['delete_after'] );
			$r['days_left'] = $r['marked'] ? max( 0, (int) round( ( strtotime( $r['delete_after'] ) - strtotime( current_time( 'Y-m-d' ) ) ) / DAY_IN_SECONDS ) ) : null;
			$r['marked_by'] = '';
			if ( $r['marked'] && $names && $r['delete_by'] ) {
				$mb             = (int) $r['delete_by'];
				$r['marked_by'] = isset( $label[ $mb ] ) ? $label[ $mb ] : ( get_userdata( $mb ) ? get_userdata( $mb )->display_name : '' );
			}
			unset( $r['delete_by'] );
			// Трасса и время прохождения → скорость
			$r['can_run']  = current_user_can( ACL_CAP ) || ( $uid && in_array( (int) $uid, $ids, true ) );
			$r['course_id'] = $r['course_id'] ? (int) $r['course_id'] : null;
			$r['run_time']  = null !== $r['run_time'] ? (float) $r['run_time'] : null;
			$r['run_pen']   = (int) $r['run_pen'];
			$r['run_dq']    = (bool) (int) $r['run_dq'];
			$r['fav']       = isset( $favs[ (int) $r['id'] ] );
			$r['tagged'] = $names ? array_values( array_filter( array_map( static function ( $u ) use ( $label ) {
				return isset( $label[ $u ] ) ? $label[ $u ] : '';
			}, $ids ) ) ) : array();
		}
		return $rows;
	}
}
