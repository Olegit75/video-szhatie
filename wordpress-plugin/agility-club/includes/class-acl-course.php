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
		$rows = $wpdb->get_results( 'SELECT id, session_id, user_id, title, note, image, created FROM ' . ACL_DB::t( 'courses' ) . ' ORDER BY id ASC', ARRAY_A ); // phpcs:ignore
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
		$date  = $wpdb->get_var( $wpdb->prepare( 'SELECT date FROM ' . ACL_DB::t( 'sessions' ) . ' WHERE id = %d', $sid ) ); // phpcs:ignore
		if ( ! $date ) {
			return self::err( 'Тренировка не найдена.', 404 );
		}
		if ( '' === $title ) {
			return self::err( 'Укажите название трассы.' );
		}
		$files = $r->get_file_params();
		if ( empty( $files['image'] ) || empty( $files['image']['tmp_name'] ) ) {
			return self::err( 'Прикрепите картинку схемы.' );
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
			'created'    => current_time( 'mysql' ),
		) );
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
}
