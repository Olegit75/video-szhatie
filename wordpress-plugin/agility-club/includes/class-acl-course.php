<?php
/**
 * Трассы к тренировкам: участники предлагают схему (картинка + описание)
 * и голосуют с комментарием за чужие схемы.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_Course {

	const MAX_IMAGE = 15728640; // 15 МБ
	const MAX_SIDE  = 1600;     // уменьшаем фото до 1600 px по длинной стороне

	public static function register() {
		$member = array( __CLASS__, 'is_member' );
		register_rest_route( ACL_API::NS, '/courses', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'create' ),
			'permission_callback' => $member,
		) );
		register_rest_route( ACL_API::NS, '/courses/(?P<id>\d+)', array(
			'methods'             => 'DELETE',
			'callback'            => array( __CLASS__, 'remove' ),
			'permission_callback' => $member,
		) );
		register_rest_route( ACL_API::NS, '/courses/(?P<id>\d+)/edit', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'edit' ),
			'permission_callback' => $member,
		) );
		register_rest_route( ACL_API::NS, '/video/(?P<id>\d+)/run', array(
			'methods'             => 'POST',
			'callback'            => array( __CLASS__, 'video_run' ),
			'permission_callback' => 'is_user_logged_in',
		) );
		register_rest_route( ACL_API::NS, '/courses/(?P<id>\d+)/vote', array(
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'vote' ),
				'permission_callback' => $member,
			),
			array(
				'methods'             => 'DELETE',
				'callback'            => array( __CLASS__, 'unvote' ),
				'permission_callback' => $member,
			),
		) );
	}

	/** Подтверждённый участник клуба (привязан к имени) или администратор. */
	public static function is_member() {
		if ( current_user_can( ACL_CAP ) ) {
			return true;
		}
		$uid = get_current_user_id();
		if ( ! $uid ) {
			return false;
		}
		foreach ( ACL_DB::members() as $m ) {
			if ( (int) $m['user_id'] === $uid ) {
				return true;
			}
		}
		return false;
	}

	private static function err( $msg, $status = 400 ) {
		return new WP_Error( 'acl_course', $msg, array( 'status' => $status ) );
	}

	/** Имя для показа: имя участника клуба, иначе отображаемое имя WordPress. */
	private static function names( array $uids ) {
		$out = array();
		foreach ( ACL_DB::members( false ) as $m ) {
			if ( $m['user_id'] && in_array( (int) $m['user_id'], $uids, true ) ) {
				$out[ (int) $m['user_id'] ] = $m['name'];
			}
		}
		foreach ( $uids as $u ) {
			if ( ! isset( $out[ $u ] ) ) {
				$ud        = get_userdata( $u );
				$out[ $u ] = $ud ? $ud->display_name : 'Участник';
			}
		}
		return $out;
	}

	/** Все трассы с голосами — для состояния страницы (только участникам). */
	public static function all() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT id, session_id, user_id, title, note, image, length_m, ran, created FROM ' . ACL_DB::t( 'courses' ) . ' ORDER BY id ASC', ARRAY_A ); // phpcs:ignore
		if ( ! $rows ) {
			return array();
		}
		$votes = $wpdb->get_results( 'SELECT course_id, user_id, comment, created FROM ' . ACL_DB::t( 'course_votes' ) . ' ORDER BY created ASC', ARRAY_A ); // phpcs:ignore
		$uids  = array();
		foreach ( $rows as $r ) {
			$uids[] = (int) $r['user_id'];
		}
		foreach ( (array) $votes as $v ) {
			$uids[] = (int) $v['user_id'];
		}
		$names = self::names( array_values( array_unique( $uids ) ) );
		$me    = get_current_user_id();
		$admin = current_user_can( ACL_CAP );
		$by    = array();
		foreach ( (array) $votes as $v ) {
			$by[ (int) $v['course_id'] ][] = array(
				'name'    => $names[ (int) $v['user_id'] ],
				'comment' => $v['comment'],
				'mine'    => (int) $v['user_id'] === $me,
			);
		}
		$results = self::results( $rows );
		$out = array();
		foreach ( $rows as $r ) {
			$list  = isset( $by[ (int) $r['id'] ] ) ? $by[ (int) $r['id'] ] : array();
			$mine  = (int) $r['user_id'] === $me;
			$myVote = '';
			foreach ( $list as $v ) {
				if ( $v['mine'] ) {
					$myVote = $v['comment'];
				}
			}
			$out[] = array(
				'id'         => (int) $r['id'],
				'session_id' => (int) $r['session_id'],
				'title'      => $r['title'],
				'note'       => $r['note'],
				'image'      => $r['image'] ? self::url( $r['image'] ) : '',
				'author'     => $names[ (int) $r['user_id'] ],
				'mine'       => $mine,
				'can_delete' => $mine || $admin,
				'length'     => null !== $r['length_m'] ? (float) $r['length_m'] : null,
				'ran'        => (bool) $r['ran'],
				'can_edit'   => $mine || $admin,
				'results'    => isset( $results[ (int) $r['id'] ] ) ? $results[ (int) $r['id'] ] : array(),
				'votes'      => $list,
				'my_vote'    => $myVote,
				'voted'      => '' !== $myVote,
			);
		}
		return $out;
	}

	private static function url( $rel ) {
		$up = wp_upload_dir();
		return trailingslashit( $up['baseurl'] ) . $rel;
	}

	public static function create( WP_REST_Request $r ) {
		global $wpdb;
		$sid   = (int) $r['session_id'];
		$title = sanitize_text_field( (string) $r['title'] );
		$note  = sanitize_textarea_field( (string) $r['note'] );
		$len   = self::parse_length( $r['length'] );
		$date  = $wpdb->get_var( $wpdb->prepare( 'SELECT date FROM ' . ACL_DB::t( 'sessions' ) . ' WHERE id = %d', $sid ) ); // phpcs:ignore
		if ( ! $date ) {
			return self::err( 'Тренировка не найдена.', 404 );
		}
		if ( '' === $title ) {
			return self::err( 'Укажите название трассы.' );
		}
		$files = $r->get_file_params();
		$has_image = ! empty( $files['image'] ) && ! empty( $files['image']['tmp_name'] );
		if ( ! $has_image && $date >= current_time( 'Y-m-d' ) ) {
			return self::err( 'Прикрепите картинку схемы.' );
		}
		if ( ! $has_image ) {
			// Прошедшая тренировка: можно добавить трассу без картинки (только название и длина)
			$wpdb->insert( ACL_DB::t( 'courses' ), array(
				'session_id' => $sid,
				'user_id'    => get_current_user_id(),
				'title'      => $title,
				'note'       => $note,
				'image'      => '',
				'length_m'   => $len,
				'ran'        => 1,
				'created'    => current_time( 'mysql' ),
			) );
			ACL_Notify::queue( 'course', $wpdb->insert_id );
			return ACL_API::state();
		}
		$f = $files['image'];
		if ( ! empty( $f['error'] ) ) {
			return self::err( 'Картинка не загрузилась (код ' . (int) $f['error'] . '). Возможно, файл слишком большой.' );
		}
		if ( (int) $f['size'] > self::MAX_IMAGE ) {
			return self::err( 'Картинка больше 15 МБ.' );
		}
		$check = wp_check_filetype_and_ext( $f['tmp_name'], $f['name'], array(
			'jpg|jpeg' => 'image/jpeg',
			'png'      => 'image/png',
			'webp'     => 'image/webp',
		) );
		if ( empty( $check['type'] ) ) {
			return self::err( 'Нужна картинка JPG, PNG или WebP.' );
		}

		$up  = wp_upload_dir();
		$rel = 'agility-courses/' . $date;
		$dir = trailingslashit( $up['basedir'] ) . $rel;
		wp_mkdir_p( $dir );
		$name   = wp_unique_filename( $dir, 'trassa-' . wp_generate_password( 6, false ) . '.' . ( $check['ext'] ? $check['ext'] : 'jpg' ) );
		$target = $dir . '/' . $name;

		// Уменьшаем большие фото; если редактор изображений недоступен — сохраняем как есть.
		$editor = wp_get_image_editor( $f['tmp_name'] );
		if ( ! is_wp_error( $editor ) ) {
			$size = $editor->get_size();
			if ( max( $size['width'], $size['height'] ) > self::MAX_SIDE ) {
				$editor->resize( self::MAX_SIDE, self::MAX_SIDE, false );
			}
			$editor->set_quality( 82 );
			$saved = $editor->save( $target );
			if ( is_wp_error( $saved ) ) {
				return self::err( 'Не удалось сохранить картинку.', 500 );
			}
			$name = basename( $saved['path'] );
		} elseif ( ! move_uploaded_file( $f['tmp_name'], $target ) ) { // phpcs:ignore
			return self::err( 'Не удалось сохранить картинку.', 500 );
		}

		$wpdb->insert( ACL_DB::t( 'courses' ), array(
			'session_id' => $sid,
			'user_id'    => get_current_user_id(),
			'title'      => $title,
			'note'       => $note,
			'image'      => $rel . '/' . $name,
			'length_m'   => $len,
			'ran'        => $date < current_time( 'Y-m-d' ) || ! empty( $r['ran'] ) ? 1 : 0,
			'created'    => current_time( 'mysql' ),
		) );
		ACL_Notify::queue( 'course', $wpdb->insert_id );
		return ACL_API::state();
	}

	/** Удаляет трассу вместе с картинкой и голосами. */
	public static function delete_row( $id ) {
		global $wpdb;
		$img = $wpdb->get_var( $wpdb->prepare( 'SELECT image FROM ' . ACL_DB::t( 'courses' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( $img && 0 === strpos( $img, 'agility-courses/' ) && false === strpos( $img, '..' ) ) {
			$up   = wp_upload_dir();
			$path = trailingslashit( $up['basedir'] ) . $img;
			if ( file_exists( $path ) ) {
				unlink( $path ); // phpcs:ignore
			}
		}
		$wpdb->delete( ACL_DB::t( 'courses' ), array( 'id' => $id ) );
		$wpdb->delete( ACL_DB::t( 'course_votes' ), array( 'course_id' => $id ) );
		$wpdb->update( ACL_DB::t( 'videos' ), array( 'course_id' => null, 'run_time' => null, 'run_pen' => 0, 'run_dq' => 0 ), array( 'course_id' => $id ) );
	}

	public static function delete_for_session( $sid ) {
		global $wpdb;
		$ids = $wpdb->get_col( $wpdb->prepare( 'SELECT id FROM ' . ACL_DB::t( 'courses' ) . ' WHERE session_id = %d', $sid ) ); // phpcs:ignore
		foreach ( $ids as $id ) {
			self::delete_row( (int) $id );
		}
	}

	public static function remove( WP_REST_Request $r ) {
		global $wpdb;
		$id     = (int) $r['id'];
		$author = $wpdb->get_var( $wpdb->prepare( 'SELECT user_id FROM ' . ACL_DB::t( 'courses' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( null === $author ) {
			return self::err( 'Трасса не найдена.', 404 );
		}
		if ( (int) $author !== get_current_user_id() && ! current_user_can( ACL_CAP ) ) {
			return self::err( 'Удалить можно только свою трассу.', 403 );
		}
		self::delete_row( $id );
		return ACL_API::state();
	}

	public static function vote( WP_REST_Request $r ) {
		global $wpdb;
		$id      = (int) $r['id'];
		$comment = sanitize_textarea_field( (string) $r['comment'] );
		$author  = $wpdb->get_var( $wpdb->prepare( 'SELECT user_id FROM ' . ACL_DB::t( 'courses' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( null === $author ) {
			return self::err( 'Трасса не найдена.', 404 );
		}
		if ( (int) $author === get_current_user_id() ) {
			return self::err( 'За свою трассу голосовать нельзя.', 403 );
		}
		if ( '' === trim( $comment ) ) {
			return self::err( 'Напишите комментарий к голосу.' );
		}
		if ( mb_strlen( $comment ) > 1000 ) {
			$comment = mb_substr( $comment, 0, 1000 );
		}
		$wpdb->replace( ACL_DB::t( 'course_votes' ), array(
			'course_id' => $id,
			'user_id'   => get_current_user_id(),
			'comment'   => $comment,
			'created'   => current_time( 'mysql' ),
		) );
		return ACL_API::state();
	}

	public static function unvote( WP_REST_Request $r ) {
		global $wpdb;
		$wpdb->delete( ACL_DB::t( 'course_votes' ), array( 'course_id' => (int) $r['id'], 'user_id' => get_current_user_id() ) );
		return ACL_API::state();
	}

	/** Длина трассы: «160», «160,5», «160 м» → 160.5; пусто или ерунда → null. */
	public static function parse_length( $v ) {
		$v = str_replace( ',', '.', preg_replace( '/[^\d.,]/', '', (string) $v ) );
		if ( '' === $v || ! is_numeric( $v ) ) {
			return null;
		}
		$f = round( (float) $v, 1 );
		return ( $f > 0 && $f < 2000 ) ? $f : null;
	}

	/** Длина и отметка «Бегали» — автор трассы или администратор. */
	public static function edit( WP_REST_Request $r ) {
		global $wpdb;
		$id     = (int) $r['id'];
		$author = $wpdb->get_var( $wpdb->prepare( 'SELECT user_id FROM ' . ACL_DB::t( 'courses' ) . ' WHERE id = %d', $id ) ); // phpcs:ignore
		if ( null === $author ) {
			return self::err( 'Трасса не найдена.', 404 );
		}
		if ( (int) $author !== get_current_user_id() && ! current_user_can( ACL_CAP ) ) {
			return self::err( 'Менять можно только свою трассу.', 403 );
		}
		$data = array();
		if ( isset( $r['length'] ) ) {
			$data['length_m'] = self::parse_length( $r['length'] );
		}
		if ( isset( $r['ran'] ) ) {
			$data['ran'] = rest_sanitize_boolean( $r['ran'] ) ? 1 : 0;
		}
		if ( $data ) {
			$wpdb->update( ACL_DB::t( 'courses' ), $data, array( 'id' => $id ) );
		}
		return ACL_API::state();
	}

	/**
	 * Трасса и время прохождения для видео. Время: секунды «38.45», «38,45» или «1:05.3».
	 * Менять может отметивший себя «Это я» или администратор. Пустое время — сброс.
	 */
	public static function video_run( WP_REST_Request $r ) {
		global $wpdb;
		$vid = (int) $r['id'];
		$row = $wpdb->get_row( $wpdb->prepare( 'SELECT id, date FROM ' . ACL_DB::t( 'videos' ) . ' WHERE id = %d', $vid ) ); // phpcs:ignore
		if ( ! $row ) {
			return self::err( 'Видео не найдено.', 404 );
		}
		if ( ! current_user_can( ACL_CAP ) ) {
			$tagged = $wpdb->get_var( $wpdb->prepare( 'SELECT 1 FROM ' . ACL_DB::t( 'video_tags' ) . ' WHERE video_id = %d AND user_id = %d', $vid, get_current_user_id() ) ); // phpcs:ignore
			if ( ! $tagged ) {
				return self::err( 'Сначала отметьте себя на видео кнопкой «Это я».', 403 );
			}
		}
		$cid = (int) $r['course_id'];
		if ( $cid ) {
			$cdate = $wpdb->get_var( $wpdb->prepare( 'SELECT s.date FROM ' . ACL_DB::t( 'courses' ) . ' c JOIN ' . ACL_DB::t( 'sessions' ) . ' s ON s.id = c.session_id WHERE c.id = %d', $cid ) ); // phpcs:ignore
			if ( ! $cdate ) {
				return self::err( 'Трасса не найдена.', 404 );
			}
			if ( $cdate !== $row->date ) {
				return self::err( 'Эта трасса относится к другому дню.' );
			}
		}
		$time = self::parse_time( $r['time'] );
		if ( false === $time ) {
			return self::err( 'Время в секундах, например 38,45 или 1:05,3.' );
		}
		$pen = trim( (string) $r['pen'] );
		if ( '' !== $pen && ( ! ctype_digit( $pen ) || (int) $pen > 999 ) ) {
			return self::err( 'Штраф — целое число баллов, например 0, 5 или 10.' );
		}
		$dq = filter_var( $r['dq'], FILTER_VALIDATE_BOOLEAN );
		$wpdb->update( ACL_DB::t( 'videos' ), array(
			'course_id' => $cid ? $cid : null,
			'run_time'  => $cid ? $time : null,
			'run_pen'   => $cid ? (int) $pen : 0,
			'run_dq'    => $cid && $dq ? 1 : 0,
		), array( 'id' => $vid ) );
		return ACL_API::state();
	}

	/** «38,45» → 38.45; «1:05.3» → 65.3; пусто → null; ошибка → false. */
	public static function parse_time( $v ) {
		$v = trim( str_replace( ',', '.', (string) $v ) );
		if ( '' === $v ) {
			return null;
		}
		if ( preg_match( '/^(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/', $v, $m ) ) {
			$t = (int) $m[1] * 60 + (float) $m[2];
		} elseif ( is_numeric( $v ) ) {
			$t = (float) $v;
		} else {
			return false;
		}
		return ( $t > 0 && $t < 3600 ) ? round( $t, 2 ) : false;
	}

	/** Результаты по трассам: видео с указанным временем → кто, время, скорость. */
	private static function results( array $courses ) {
		global $wpdb;
		$len = array();
		foreach ( $courses as $c ) {
			$len[ (int) $c['id'] ] = null !== $c['length_m'] ? (float) $c['length_m'] : null;
		}
		$rows = $wpdb->get_results( 'SELECT id, course_id, run_time, run_pen, run_dq FROM ' . ACL_DB::t( 'videos' ) . ' WHERE course_id IS NOT NULL AND ( run_time IS NOT NULL OR run_dq = 1 ) ORDER BY run_dq ASC, run_pen ASC, run_time IS NULL, run_time ASC', ARRAY_A ); // phpcs:ignore
		if ( ! $rows ) {
			return array();
		}
		$tags = $wpdb->get_results( 'SELECT video_id, user_id FROM ' . ACL_DB::t( 'video_tags' ), ARRAY_A ); // phpcs:ignore
		$byv  = array();
		$uids = array();
		foreach ( (array) $tags as $t ) {
			$byv[ (int) $t['video_id'] ][] = (int) $t['user_id'];
			$uids[]                         = (int) $t['user_id'];
		}
		$names = self::names( array_values( array_unique( $uids ) ) );
		$out   = array();
		foreach ( $rows as $v ) {
			$cid = (int) $v['course_id'];
			$t   = null !== $v['run_time'] ? (float) $v['run_time'] : null;
			$who = array();
			foreach ( isset( $byv[ (int) $v['id'] ] ) ? $byv[ (int) $v['id'] ] : array() as $u ) {
				$who[] = $names[ $u ];
			}
			$out[ $cid ][] = array(
				'video_id' => (int) $v['id'],
				'who'      => $who ? implode( ', ', $who ) : 'без отметки',
				'time'     => $t,
				'pen'      => (int) $v['run_pen'],
				'dq'       => (bool) (int) $v['run_dq'],
				'speed'    => ( isset( $len[ $cid ] ) && $len[ $cid ] && $t > 0 ) ? round( $len[ $cid ] / $t, 2 ) : null,
			);
		}
		return $out;
	}

	/** Название и длина трасс, которые бегали, — для подписей под видео (видно всем). */
	public static function titles() {
		global $wpdb;
		$rows = $wpdb->get_results( 'SELECT c.id, c.title, c.length_m, c.ran, s.date FROM ' . ACL_DB::t( 'courses' ) . ' c JOIN ' . ACL_DB::t( 'sessions' ) . ' s ON s.id = c.session_id', ARRAY_A ); // phpcs:ignore
		$out  = array();
		foreach ( (array) $rows as $r ) {
			$out[] = array(
				'id'     => (int) $r['id'],
				'title'  => $r['title'],
				'length' => null !== $r['length_m'] ? (float) $r['length_m'] : null,
				'ran'    => (bool) $r['ran'],
				'date'   => $r['date'],
			);
		}
		return $out;
	}
}
