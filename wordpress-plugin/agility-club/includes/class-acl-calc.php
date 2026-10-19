<?php
/**
 * Расчёт стоимости тренировки — та же формула, что в таблице Excel клуба:
 *   аренда Q = (часы − бесплатные часы) × ставка
 *   долей O = участники + доли организатора (если он был)
 *   доля организатора R = Q ÷ O × доли − скидка
 *   с участника C = (Q − R) ÷ участники
 *   минут на собаку = (часы × 60 − постановка − уборка) ÷ O
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class ACL_Calc {

	public static function session( array $s, array $members, array $marks_for_session, array $cfg ) {
		$org_in = false;
		$att    = array();
		foreach ( $members as $m ) {
			$mk = isset( $marks_for_session[ $m['id'] ] ) ? $marks_for_session[ $m['id'] ] : '';
			if ( ! $mk ) {
				continue;
			}
			if ( $m['is_organizer'] ) {
				$org_in = true;
			} else {
				$att[] = $m;
			}
		}
		$n      = count( $att );
		$shares = (float) $cfg['org_shares'];
		$o      = $n + ( $org_in ? $shares : 0 );
		$q      = max( (float) $s['hours'] - (float) $cfg['free_hours'], 0 ) * (float) $cfg['rate'];
		$r      = ( $org_in && $o > 0 ) ? $q / $o * $shares - (float) $cfg['org_discount'] : 0.0;
		$c      = $n > 0 ? ( $q - $r ) / $n : null;
		$free   = (float) $s['hours'] * 60 - ( (float) $cfg['setup_min'] + (float) $cfg['cleanup_min'] );

		return array(
			'n'       => $n,
			'shares'  => $o,
			'rent'    => $q,
			'org'     => $org_in ? $r : null,
			'org_in'  => $org_in,
			'per'     => $c,
			'per_dog' => $o > 0 ? $free / $o : null,
			'att'     => array_map(
				static function ( $m ) {
					return $m['id'];
				},
				$att
			),
		);
	}
}
