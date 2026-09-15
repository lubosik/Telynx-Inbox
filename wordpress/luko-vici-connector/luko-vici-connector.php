<?php
/**
 * Plugin Name: LUKO Vici Connector
 * Description: WooCommerce abandoned-cart recovery, SMS consent bridge and LUKO event connector for Vici.
 * Version: 0.3.1
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * Author: LUKO
 * Text Domain: luko-vici-connector
 */

if ( ! defined( 'ABSPATH' ) ) exit;

final class LUKO_Vici_Connector {
    const VERSION = '0.3.1';
    private static $restoring = false;
    private static $cart_dirty = false;

    public static function boot() {
        self::maybe_upgrade();
        add_action( 'eael/login-register/before-register-footer', [ __CLASS__, 'render_registration_consent' ] );
        add_filter( 'eael/login-register/new-user-data', [ __CLASS__, 'capture_registration_evidence' ], 20 );
        add_action( 'eael/login-register/after-insert-user', [ __CLASS__, 'after_eael_insert' ], 20, 3 );
        add_action( 'register_new_user', [ __CLASS__, 'registration_completed' ], 20 );
        add_action( 'deleted_user_meta', [ __CLASS__, 'otp_verified' ], 20, 4 );
        add_action( 'shutdown', [ __CLASS__, 'flush_cart' ], 5 );
        add_action( 'luko_vici_drain_outbox', [ __CLASS__, 'drain_outbox' ] );
        add_action( 'rest_api_init', [ __CLASS__, 'register_rest' ] );
        add_action( 'woocommerce_before_checkout_form', [ __CLASS__, 'capture_cart' ], 99 );

        add_action( 'woocommerce_add_to_cart', [ __CLASS__, 'capture_cart' ], 99 );
        add_action( 'woocommerce_after_cart_item_quantity_update', [ __CLASS__, 'capture_cart' ], 99 );
        add_action( 'woocommerce_cart_item_removed', [ __CLASS__, 'capture_cart' ], 99 );
        add_action( 'woocommerce_applied_coupon', [ __CLASS__, 'capture_cart' ], 99 );
        add_action( 'woocommerce_removed_coupon', [ __CLASS__, 'capture_cart' ], 99 );
        add_action( 'woocommerce_cart_emptied', [ __CLASS__, 'cart_emptied' ], 99 );

        add_action( 'init', [ __CLASS__, 'rewrite' ] );
        add_filter( 'query_vars', [ __CLASS__, 'query_vars' ] );
        add_action( 'template_redirect', [ __CLASS__, 'handle_recovery' ] );

        add_action( 'woocommerce_checkout_order_created', [ __CLASS__, 'order_created' ], 20 );
        add_action( 'woocommerce_store_api_checkout_order_processed', [ __CLASS__, 'order_created' ], 20 );
        add_action( 'woocommerce_payment_complete', [ __CLASS__, 'order_paid' ], 20 );
        add_action( 'woocommerce_order_status_processing', [ __CLASS__, 'order_paid' ], 20 );
        add_action( 'woocommerce_order_status_completed', [ __CLASS__, 'order_paid' ], 20 );

        add_action( 'admin_menu', [ __CLASS__, 'admin_menu' ] );
        add_action( 'admin_init', [ __CLASS__, 'admin_settings' ] );
    }

    public static function activate() {
        global $wpdb;
        $table = self::table();
        $charset = $wpdb->get_charset_collate();
        $sql = "CREATE TABLE {$table} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            external_cart_id CHAR(36) NOT NULL,
            user_id BIGINT UNSIGNED NOT NULL,
            token_hash CHAR(64) NOT NULL,
            token_encrypted LONGTEXT NULL,
            version BIGINT UNSIGNED NOT NULL DEFAULT 0,
            payload LONGTEXT NOT NULL,
            currency VARCHAR(8) NOT NULL DEFAULT 'USD',
            total DECIMAL(18,2) NOT NULL DEFAULT 0,
            status VARCHAR(24) NOT NULL DEFAULT 'active',
            last_activity_at DATETIME NOT NULL,
            clicked_at DATETIME NULL,
            order_id BIGINT UNSIGNED NULL,
            recovered_at DATETIME NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY external_cart_id (external_cart_id),
            UNIQUE KEY token_hash (token_hash),
            KEY user_status (user_id, status),
            KEY order_id (order_id)
        ) {$charset};";
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        dbDelta( $sql );
        $outbox = $wpdb->prefix . 'luko_recovery_outbox';
        dbDelta( "CREATE TABLE {$outbox} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            event_id CHAR(36) NOT NULL,
            body_encrypted LONGTEXT NOT NULL,
            attempts INT UNSIGNED NOT NULL DEFAULT 0,
            available_at DATETIME NOT NULL,
            locked_until DATETIME NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            UNIQUE KEY event_id (event_id),
            KEY due (available_at, locked_until)
        ) {$charset};" );
        update_option( 'luko_vici_schema_version', self::VERSION, false );
        self::rewrite();
        flush_rewrite_rules();
    }

    public static function deactivate() { flush_rewrite_rules(); }

    public static function maybe_upgrade() {
        if ( get_option( 'luko_vici_schema_version' ) !== self::VERSION ) self::activate();
    }

    // AEAD keeps recoverable bearer tokens and queued PII out of plaintext WP tables.
    private static function seal( $value ) {
        if ( ! function_exists( 'openssl_encrypt' ) ) throw new RuntimeException( 'Encryption unavailable' );
        $iv = random_bytes( 12 );
        $tag = '';
        $cipher = openssl_encrypt( $value, 'aes-256-gcm', hash( 'sha256', wp_salt( 'auth' ), true ), OPENSSL_RAW_DATA, $iv, $tag );
        if ( false === $cipher ) throw new RuntimeException( 'Encryption unavailable' );
        return base64_encode( $iv . $tag . $cipher );
    }

    private static function unseal( $value ) {
        $bytes = base64_decode( (string) $value, true );
        if ( false === $bytes || strlen( $bytes ) < 29 ) return false;
        return openssl_decrypt( substr( $bytes, 28 ), 'aes-256-gcm', hash( 'sha256', wp_salt( 'auth' ), true ), OPENSSL_RAW_DATA, substr( $bytes, 0, 12 ), substr( $bytes, 12, 16 ) );
    }

    private static function table() {
        global $wpdb;
        return $wpdb->prefix . 'luko_recovery_carts';
    }

    private static function disclosure_text() {
        $saved = trim( (string) get_option( 'luko_vici_sms_disclosure', '' ) );
        if ( $saved ) return $saved;
        return 'I agree to receive recurring automated SMS messages from Vici Peptides, including shopping cart reminders and other Vici updates. Message frequency may vary. Standard message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase. We will not sell or share mobile information with third parties for promotional or marketing purposes.';
    }

    public static function render_registration_consent() {
        $privacy = self::privacy_url();
        $terms = self::terms_url();
        echo '<style>
            [data-luko-sms-consent="1"] label { cursor:pointer; }
            [data-luko-sms-consent="1"] input[name="luko_sms_consent"] {
                -webkit-appearance:checkbox !important;
                appearance:auto !important;
                box-sizing:border-box !important;
                display:block !important;
                flex:0 0 24px !important;
                width:24px !important;
                min-width:24px !important;
                max-width:24px !important;
                height:24px !important;
                min-height:24px !important;
                margin:2px 0 0 !important;
                padding:0 !important;
                opacity:1 !important;
                position:static !important;
                transform:none !important;
                accent-color:#158c83;
                cursor:pointer;
            }
        </style>';
        echo '<div data-luko-sms-consent="1" class="eael-lr-form-group" style="margin:14px 0;font-size:12px;line-height:1.45">';
        echo '<label style="display:flex;gap:9px;align-items:flex-start"><input type="checkbox" name="luko_sms_consent" value="1"><span>' . esc_html( self::disclosure_text() ) . '</span></label>';
        echo '<div><a target="_blank" rel="noopener" href="' . esc_url( $privacy ) . '">Privacy Policy</a> &middot; <a target="_blank" rel="noopener" href="' . esc_url( $terms ) . '">Terms</a></div>';
        echo '<input type="hidden" name="luko_sms_disclosure_fingerprint" value="' . esc_attr( self::disclosure_fingerprint() ) . '"></div>';
    }

    private static function terms_url() {
        $saved = get_option( 'luko_vici_terms_url', '' );
        $woo = function_exists( 'wc_get_page_permalink' ) ? wc_get_page_permalink( 'terms' ) : '';
        return $saved ? $saved : ( $woo ? $woo : home_url( '/terms-and-conditions/' ) );
    }

    private static function privacy_url() {
        $wordpress = get_privacy_policy_url();
        return $wordpress ? $wordpress : home_url( '/privacy-policy/' );
    }

    private static function disclosure_fingerprint() {
        return hash_hmac( 'sha256', self::disclosure_text() . '|' . get_option( 'luko_vici_sms_disclosure_version', 'v1' ) . '|' . self::privacy_url() . '|' . self::terms_url(), wp_salt( 'auth' ) );
    }

    // EA 6.8.3 applies this AFTER validating its nonce and fields, BEFORE saving
    // the OTP payload. meta_input is supported by wp_insert_user in both modes.
    // No cookies, OTP session mutation, password access or authentication hooks.
    public static function capture_registration_evidence( $data ) {
        $supplied = isset( $_POST['luko_sms_disclosure_fingerprint'] ) && is_string( $_POST['luko_sms_disclosure_fingerprint'] ) ? wp_unslash( $_POST['luko_sms_disclosure_fingerprint'] ) : '';
        $valid = hash_equals( self::disclosure_fingerprint(), $supplied );
        $phone = isset( $_POST['phone_number'] ) && is_string( $_POST['phone_number'] ) ? self::normalize_phone( wp_unslash( $_POST['phone_number'] ) ) : '';
        $checked = isset( $_POST['luko_sms_consent'] ) && '1' === $_POST['luko_sms_consent'];
        $evidence = [
            'granted' => $valid && $checked && '' !== $phone && '' !== self::privacy_url() && '' !== self::terms_url(),
            'disclosure' => self::disclosure_text(),
            'version' => (string) get_option( 'luko_vici_sms_disclosure_version', 'v1' ),
            'occurred_at' => gmdate( 'c' ),
            'source' => 'vici_registration',
            'source_url' => isset( $_POST['page_id'] ) ? get_permalink( absint( $_POST['page_id'] ) ) : ( wp_get_referer() ?: home_url( '/login/' ) ),
            'phone' => $phone,
            'privacy_url' => self::privacy_url(),
            'terms_url' => self::terms_url(),
            'ip_hash' => empty( $_SERVER['REMOTE_ADDR'] ) ? '' : hash_hmac( 'sha256', (string) $_SERVER['REMOTE_ADDR'], wp_salt( 'auth' ) ),
            'user_agent_hash' => empty( $_SERVER['HTTP_USER_AGENT'] ) ? '' : hash_hmac( 'sha256', (string) $_SERVER['HTTP_USER_AGENT'], wp_salt( 'auth' ) ),
        ];
        $data['meta_input'] = isset( $data['meta_input'] ) && is_array( $data['meta_input'] ) ? $data['meta_input'] : [];
        $data['meta_input']['_luko_pending_consent_evidence'] = $evidence;
        return $data;
    }

    public static function after_eael_insert( $user_id, $user_data, $settings ) {
        self::sync_phone_to_billing( (int) $user_id );
        if ( '1' !== get_user_meta( $user_id, '_eael_otp_pending', true ) ) self::finalize_consent( (int) $user_id );
    }

    public static function otp_verified( $meta_ids, $user_id, $meta_key, $value ) {
        if ( '_eael_otp_pending' === $meta_key ) self::registration_completed( $user_id );
    }

    public static function registration_completed( $user_id ) {
        if ( '1' === get_user_meta( $user_id, '_eael_otp_pending', true ) ) return;
        update_user_meta( (int) $user_id, '_luko_registration_complete', gmdate( 'c' ) );
        self::sync_phone_to_billing( (int) $user_id );
        self::finalize_consent( (int) $user_id );
    }

    public static function normalize_phone( $value ) {
        $value = trim( (string) $value );
        if ( preg_match( '/[a-z]/i', $value ) ) return '';
        $digits = preg_replace( '/[^0-9]/', '', $value );
        if ( 0 === strpos( $value, '00' ) ) $digits = substr( $digits, 2 );
        elseif ( '+' !== substr( $value, 0, 1 ) ) {
            $country = function_exists( 'wc_get_base_location' ) ? ( wc_get_base_location()['country'] ?? '' ) : '';
            if ( in_array( $country, [ 'US', 'CA' ], true ) && 10 === strlen( $digits ) ) $digits = '1' . $digits;
            elseif ( in_array( $country, [ 'US', 'CA' ], true ) && 11 === strlen( $digits ) && '1' === $digits[0] ) { /* NANP */ }
            else return '';
        }
        return preg_match( '/^[1-9][0-9]{7,14}$/', $digits ) ? '+' . $digits : '';
    }

    private static function resolve_phone( $user_id ) {
        // Live /my-account/ name="phone_number" + official EA 6.8.3 prefix mapping.
        $configured = sanitize_key( (string) get_option( 'luko_vici_phone_meta_key', 'eael_custom_profile_field_phone_number' ) );
        foreach ( array_unique( [ $configured, 'eael_custom_profile_field_phone_number', 'billing_phone' ] ) as $key ) {
            if ( ! $key ) continue;
            $phone = self::normalize_phone( get_user_meta( $user_id, $key, true ) );
            if ( $phone ) return $phone;
        }
        return '';
    }

    private static function sync_phone_to_billing( $user_id ) {
        $phone = self::resolve_phone( $user_id );
        if ( ! $phone ) return;
        update_user_meta( $user_id, 'billing_phone', $phone );
        if ( class_exists( 'WC_Customer' ) ) {
            $customer = new WC_Customer( $user_id );
            if ( $customer->get_id() ) {
                $customer->set_billing_phone( $phone );
                $customer->save();
            }
        }
    }

    private static function finalize_consent( $user_id ) {
        $evidence = get_user_meta( $user_id, '_luko_pending_consent_evidence', true );
        if ( ! is_array( $evidence ) || '1' === get_user_meta( $user_id, '_eael_otp_pending', true ) ) return;
        $evidence['granted'] = true === ( $evidence['granted'] ?? false ) && self::resolve_phone( $user_id ) === ( $evidence['phone'] ?? '' ) && '' !== ( $evidence['phone'] ?? '' );
        update_user_meta( $user_id, '_luko_consent_evidence', $evidence );
        update_user_meta( $user_id, 'luko_sms_consent', $evidence['granted'] ? 'yes' : 'no' );
        foreach ( [ 'timestamp' => 'occurred_at', 'source' => 'source', 'version' => 'version', 'text' => 'disclosure', 'phone' => 'phone' ] as $key => $source ) update_user_meta( $user_id, 'luko_sms_consent_' . $key, $evidence[$source] ?? '' );
        if ( self::emit( 'consent.updated', [ 'customer' => self::customer_payload( $user_id ), 'consent' => $evidence ] ) ) delete_user_meta( $user_id, '_luko_pending_consent_evidence' );
    }

    private static function has_consent( $user_id ) {
        $evidence = get_user_meta( $user_id, '_luko_consent_evidence', true );
        return $user_id > 0 && '1' !== get_user_meta( $user_id, '_eael_otp_pending', true ) && 'yes' === get_user_meta( $user_id, 'luko_sms_consent', true ) && is_array( $evidence ) && true === ( $evidence['granted'] ?? false ) && ! empty( $evidence['phone'] ) && self::resolve_phone( $user_id ) === $evidence['phone'];
    }

    private static function customer_payload( $user_id ) {
        $u = get_userdata( $user_id );
        $e = get_user_meta( $user_id, '_luko_consent_evidence', true );
        return [
            'wordpress_user_id' => (int) $user_id, 'email' => $u ? $u->user_email : '',
            'phone' => self::resolve_phone( $user_id ), 'sms_consent' => self::has_consent( $user_id ),
            'sms_consent_at' => $e['occurred_at'] ?? '', 'consent_version' => $e['version'] ?? '',
        ];
    }

    private static function active_cart_for_user( $user_id ) {
        global $wpdb;
        return $wpdb->get_row( $wpdb->prepare(
            'SELECT * FROM ' . self::table() . " WHERE user_id=%d AND status IN ('active','clicked') ORDER BY updated_at DESC LIMIT 1",
            $user_id
        ) );
    }

    public static function capture_cart() {
        if ( ! self::$restoring ) self::$cart_dirty = true;
    }

    public static function flush_cart() {
        if ( ! self::$cart_dirty || self::$restoring || ! is_user_logged_in() || ! function_exists( 'WC' ) || ! WC()->cart ) return;
        self::$cart_dirty = false;
        $user_id = get_current_user_id();
        if ( ! self::has_consent( $user_id ) ) return;
        if ( WC()->cart->is_empty() ) { self::cart_emptied(); return; }

        $items = [];
        foreach ( WC()->cart->get_cart() as $item ) {
            $items[] = [
                'product_id' => (int) $item['product_id'],
                'variation_id' => (int) $item['variation_id'],
                'quantity' => (int) $item['quantity'],
                'variation' => is_array( $item['variation'] ?? null ) ? $item['variation'] : [],
            ];
        }

        $totals = WC()->cart->get_totals();
        $total = isset( $totals['total'] ) ? (float) $totals['total'] : 0;
        $currency = get_woocommerce_currency();
        $now = current_time( 'mysql', true );
        $ttl = max( 1, (int) get_option( 'luko_vici_recovery_ttl_days', 7 ) );
        $expires = gmdate( 'Y-m-d H:i:s', time() + DAY_IN_SECONDS * $ttl );
        $row = self::active_cart_for_user( $user_id );
        global $wpdb;

        if ( $row ) {
            $external = $row->external_cart_id;
            $raw_token = ! empty( $row->token_encrypted ) ? self::unseal( $row->token_encrypted ) : false;
            if ( ! $raw_token ) $raw_token = self::new_token();
            $token_hash = hash( 'sha256', $raw_token );
            $version = (int) $row->version + 1;
            $wpdb->update( self::table(), [
                'token_hash' => $token_hash,
                'token_encrypted' => self::seal( $raw_token ),
                'version' => $version,
                'payload' => wp_json_encode( [ 'items' => $items ] ),
                'currency' => $currency,
                'total' => $total,
                'status' => 'active',
                'last_activity_at' => $now,
                'expires_at' => $expires,
                'updated_at' => $now,
            ], [ 'id' => $row->id ] );
        } else {
            $external = wp_generate_uuid4();
            $raw_token = self::new_token();
            $token_hash = hash( 'sha256', $raw_token );
            $version = 1;
            $wpdb->insert( self::table(), [
                'external_cart_id' => $external,
                'user_id' => $user_id,
                'token_hash' => $token_hash,
                'token_encrypted' => self::seal( $raw_token ),
                'version' => $version,
                'payload' => wp_json_encode( [ 'items' => $items ] ),
                'currency' => $currency,
                'total' => $total,
                'status' => 'active',
                'last_activity_at' => $now,
                'expires_at' => $expires,
                'created_at' => $now,
                'updated_at' => $now,
            ] );
        }

        self::emit( 'cart.updated', [
            'customer' => self::customer_payload( $user_id ),
            'consent' => get_user_meta( $user_id, '_luko_consent_evidence', true ),
            'cart' => [
                'external_cart_id' => $external,
                'version' => $version,
                'currency' => $currency,
                'total' => number_format( $total, 2, '.', '' ),
                'last_activity_at' => gmdate( 'c' ),
                'expires_at' => gmdate( 'c', strtotime( $expires . ' UTC' ) ),
                'recovery_url' => home_url( '/r/' . rawurlencode( $raw_token ) ),
                'items' => $items,
            ],
        ] );
    }

    public static function cart_emptied() {
        if ( self::$restoring || ! is_user_logged_in() ) return;
        self::$cart_dirty = false;
        $row = self::active_cart_for_user( get_current_user_id() );
        if ( ! $row ) return;
        global $wpdb;
        $version = (int) $row->version + 1;
        $wpdb->update( self::table(), [ 'status' => 'emptied', 'version' => $version, 'updated_at' => current_time( 'mysql', true ) ], [ 'id' => $row->id ] );
        self::emit( 'cart.emptied', [ 'customer' => self::customer_payload( get_current_user_id() ), 'cart' => [ 'external_cart_id' => $row->external_cart_id, 'version' => $version ] ] );
    }

    private static function new_token() { return rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' ); }

    public static function rewrite() { add_rewrite_rule( '^r/([A-Za-z0-9_-]{43}|[A-Fa-f0-9]{64})/?$', 'index.php?luko_recover=$matches[1]', 'top' ); }
    public static function query_vars( $vars ) { $vars[] = 'luko_recover'; return $vars; }

    public static function handle_recovery() {
        $token = (string) get_query_var( 'luko_recover' );
        if ( ! $token ) return;
        if ( ! preg_match( '/^(?:[A-Za-z0-9_-]{43}|[A-Fa-f0-9]{64})$/', $token ) ) { status_header( 404 ); exit( esc_html__( 'Invalid recovery link.', 'luko-vici-connector' ) ); }
        if ( ! self::allow_request( 'recovery', 30, 10 * MINUTE_IN_SECONDS ) ) { status_header( 429 ); exit( esc_html__( 'Please try again shortly.', 'luko-vici-connector' ) ); }
        global $wpdb;
        $row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE token_hash=%s LIMIT 1', hash( 'sha256', $token ) ) );
        if ( ! $row || strtotime( $row->expires_at . ' UTC' ) < time() || in_array( $row->status, [ 'emptied', 'ordered', 'paid', 'recovered', 'expired' ], true ) ) { status_header( 410 ); exit( esc_html__( 'This recovery link is no longer available.', 'luko-vici-connector' ) ); }
        if ( function_exists( 'wc_load_cart' ) && ( ! function_exists( 'WC' ) || null === WC()->cart ) ) wc_load_cart();
        if ( ! function_exists( 'WC' ) || ! WC()->cart ) { status_header( 500 ); exit( esc_html__( 'Cart unavailable.', 'luko-vici-connector' ) ); }
        $payload = json_decode( $row->payload, true );
        $items = is_array( $payload['items'] ?? null ) ? $payload['items'] : [];
        if ( ! $items ) { status_header( 410 ); exit( esc_html__( 'This cart has no recoverable items.', 'luko-vici-connector' ) ); }
        self::$restoring = true;
        WC()->cart->empty_cart();
        $restored = 0;
        foreach ( $items as $item ) {
            $pid = (int) ( $item['product_id'] ?? 0 );
            $vid = (int) ( $item['variation_id'] ?? 0 );
            $qty = max( 1, (int) ( $item['quantity'] ?? 1 ) );
            $variation = is_array( $item['variation'] ?? null ) ? $item['variation'] : [];
            $product = wc_get_product( $vid ?: $pid );
            if ( ! $product || ! $product->is_purchasable() || ! $product->is_in_stock() ) continue;
            if ( WC()->cart->add_to_cart( $pid, $qty, $vid, $variation ) ) $restored++;
        }
        self::$restoring = false;
        if ( ! $restored ) { status_header( 410 ); exit( esc_html__( 'The items in this cart are no longer available.', 'luko-vici-connector' ) ); }
        WC()->cart->calculate_totals();
        $version = (int) $row->version + 1;
        $clicked = gmdate( 'c' );
        $wpdb->update( self::table(), [ 'status' => 'clicked', 'version' => $version, 'clicked_at' => current_time( 'mysql', true ), 'updated_at' => current_time( 'mysql', true ) ], [ 'id' => $row->id ] );
        if ( WC()->session ) WC()->session->set( 'luko_recovery_context', [
            'external_cart_id' => (string) $row->external_cart_id,
            'clicked_at' => $clicked,
            'expires_at' => gmdate( 'c', time() + DAY_IN_SECONDS ),
        ] );
        self::emit( 'cart.clicked', [ 'customer' => self::customer_payload( (int) $row->user_id ), 'cart' => [ 'external_cart_id' => $row->external_cart_id, 'version' => $version ] ] );
        wp_safe_redirect( wc_get_checkout_url() ); exit;
    }

    public static function order_created( $order ) {
        if ( ! $order instanceof WC_Order || $order->get_meta( '_luko_order_created_event_id', true ) ) return;
        global $wpdb;
        $context = function_exists( 'WC' ) && WC()->session ? WC()->session->get( 'luko_recovery_context' ) : [];
        $external = is_array( $context ) ? sanitize_text_field( (string) ( $context['external_cart_id'] ?? '' ) ) : '';
        if ( ! $external ) $external = sanitize_text_field( (string) $order->get_meta( '_luko_recovery_cart_id', true ) );
        $clicked_at = is_array( $context ) ? (string) ( $context['clicked_at'] ?? '' ) : '';
        if ( ! $clicked_at ) $clicked_at = (string) $order->get_meta( '_luko_recovery_clicked_at', true );
        $context_valid = $external && strtotime( (string) ( $context['expires_at'] ?? '' ) ) >= time();
        $row = $external ? $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE external_cart_id=%s LIMIT 1', $external ) ) : self::active_cart_for_user( (int) $order->get_user_id() );
        if ( ! $row ) return;
        $attribution_valid = 'yes' === $order->get_meta( '_luko_recovery_attribution_valid', true ) || ( $context_valid && 'clicked' === $row->status && self::order_matches_cart( $order, $row ) );
        $event_id = wp_generate_uuid4();
        $order->update_meta_data( '_luko_recovery_cart_id', $row->external_cart_id );
        $order->update_meta_data( '_luko_recovery_clicked_at', $clicked_at );
        $order->update_meta_data( '_luko_recovery_attribution_valid', $attribution_valid ? 'yes' : 'no' );
        $order->save();
        $wpdb->update( self::table(), [ 'order_id' => $order->get_id(), 'status' => 'ordered', 'updated_at' => current_time( 'mysql', true ) ], [ 'id' => $row->id ] );
        $queued = self::emit( 'order.created', [
            'customer' => self::customer_payload( (int) $order->get_user_id() ),
            'cart' => [ 'external_cart_id' => $row->external_cart_id, 'version' => (int) $row->version ],
            'order' => [ 'order_id' => $order->get_id(), 'currency' => $order->get_currency(), 'total' => $order->get_total(), 'status' => $order->get_status(), 'recovery_clicked_at' => $clicked_at ?: null, 'attribution_valid' => $attribution_valid ],
        ], $event_id );
        if ( $queued ) { $order->update_meta_data( '_luko_order_created_event_id', $event_id ); $order->save(); }
        if ( function_exists( 'WC' ) && WC()->session ) WC()->session->__unset( 'luko_recovery_context' );
    }

    public static function order_paid( $order_id ) {
        $order = $order_id instanceof WC_Order ? $order_id : wc_get_order( $order_id );
        if ( ! $order || ! in_array( $order->get_status(), [ 'processing', 'completed' ], true ) || $order->get_meta( '_luko_order_paid_event_id', true ) ) return;
        $external = (string) $order->get_meta( '_luko_recovery_cart_id', true );
        if ( ! $external ) return;
        global $wpdb;
        $row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE external_cart_id=%s LIMIT 1', $external ) );
        if ( ! $row ) return;
        $event_id = wp_generate_uuid4();
        $valid = 'yes' === $order->get_meta( '_luko_recovery_attribution_valid', true );
        $wpdb->update( self::table(), [ 'status' => 'paid', 'updated_at' => current_time( 'mysql', true ) ], [ 'id' => $row->id ] );
        $queued = self::emit( 'order.paid', [
            'customer' => self::customer_payload( (int) $order->get_user_id() ),
            'cart' => [ 'external_cart_id' => $external, 'version' => (int) $row->version ],
            'order' => [ 'order_id' => $order->get_id(), 'currency' => $order->get_currency(), 'total' => $order->get_total(), 'status' => $order->get_status(), 'paid_at' => gmdate( 'c' ), 'recovery_clicked_at' => $order->get_meta( '_luko_recovery_clicked_at', true ) ?: null, 'attribution_valid' => $valid ],
        ], $event_id );
        if ( $queued ) { $order->update_meta_data( '_luko_order_paid_event_id', $event_id ); $order->save(); }
    }

    private static function order_matches_cart( $order, $row ) {
        $payload = json_decode( (string) $row->payload, true );
        $snapshot = [];
        foreach ( (array) ( $payload['items'] ?? [] ) as $item ) $snapshot[(int) ( $item['variation_id'] ?: $item['product_id'] )] = true;
        foreach ( $order->get_items() as $item ) {
            $product_id = (int) ( $item->get_variation_id() ?: $item->get_product_id() );
            if ( isset( $snapshot[$product_id] ) ) return true;
        }
        return false;
    }

    private static function signing_secret() {
        return defined( 'LUKO_WP_SIGNING_SECRET' ) ? (string) LUKO_WP_SIGNING_SECRET : (string) get_option( 'luko_vici_signing_secret', '' );
    }

    private static function emit( $event_type, $payload, $event_id = '' ) {
        if ( ! get_option( 'luko_vici_enabled' ) ) return false;
        $base = rtrim( (string) get_option( 'luko_vici_api_base', '' ), '/' );
        $secret = self::signing_secret();
        if ( ! $base || ! $secret ) return false;
        $event = array_merge( [ 'event_id' => $event_id ?: wp_generate_uuid4(), 'event_type' => $event_type, 'occurred_at' => gmdate( 'c' ), 'store' => 'vici' ], $payload );
        $body = wp_json_encode( $event, JSON_UNESCAPED_SLASHES );
        global $wpdb;
        $queued = $wpdb->query( $wpdb->prepare(
            'INSERT IGNORE INTO ' . $wpdb->prefix . 'luko_recovery_outbox (event_id,body_encrypted,attempts,available_at,created_at) VALUES (%s,%s,0,%s,%s)',
            $event['event_id'], self::seal( $body ), current_time( 'mysql', true ), current_time( 'mysql', true )
        ) );
        if ( false === $queued ) return false;
        self::drain_outbox( 1 );
        self::schedule_outbox();
        return true;
    }

    private static function schedule_outbox() {
        if ( function_exists( 'as_next_scheduled_action' ) && function_exists( 'as_schedule_single_action' ) ) {
            if ( ! as_next_scheduled_action( 'luko_vici_drain_outbox', [], 'luko' ) ) as_schedule_single_action( time() + MINUTE_IN_SECONDS, 'luko_vici_drain_outbox', [], 'luko' );
            return;
        }
        if ( ! wp_next_scheduled( 'luko_vici_drain_outbox' ) ) wp_schedule_single_event( time() + MINUTE_IN_SECONDS, 'luko_vici_drain_outbox' );
    }

    public static function drain_outbox( $limit = 10 ) {
        if ( ! get_option( 'luko_vici_enabled' ) ) return;
        $base = rtrim( (string) get_option( 'luko_vici_api_base', '' ), '/' );
        $secret = self::signing_secret();
        if ( ! $base || ! $secret ) return;
        global $wpdb;
        $table = $wpdb->prefix . 'luko_recovery_outbox';
        $limit = min( 20, max( 1, absint( $limit ) ) );
        $rows = $wpdb->get_results( "SELECT * FROM {$table} WHERE available_at <= UTC_TIMESTAMP() AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP()) ORDER BY id LIMIT {$limit}" );
        foreach ( $rows as $row ) {
            $locked = $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET locked_until=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 30 SECOND) WHERE id=%d AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP())", $row->id ) );
            if ( 1 !== $locked ) continue;
            $body = self::unseal( $row->body_encrypted );
            if ( false === $body ) { $wpdb->delete( $table, [ 'id' => $row->id ], [ '%d' ] ); continue; }
            $ts = (string) time();
            $sig = hash_hmac( 'sha256', $ts . '.' . $body, $secret );
            $response = wp_remote_post( $base . '/v1/woocommerce/events', [
                'timeout' => 4,
                'headers' => [ 'Content-Type' => 'application/json', 'X-LUKO-Timestamp' => $ts, 'X-LUKO-Signature' => 'sha256=' . $sig ],
                'body' => $body,
            ] );
            $code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
            if ( $code >= 200 && $code < 300 ) { $wpdb->delete( $table, [ 'id' => $row->id ], [ '%d' ] ); continue; }
            $attempts = (int) $row->attempts + 1;
            $delay = min( HOUR_IN_SECONDS, (int) pow( 2, min( $attempts, 6 ) ) * MINUTE_IN_SECONDS );
            $wpdb->update( $table, [ 'attempts' => $attempts, 'available_at' => gmdate( 'Y-m-d H:i:s', time() + $delay ), 'locked_until' => null ], [ 'id' => $row->id ] );
        }
        if ( (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$table}" ) > 0 ) self::schedule_outbox();
    }

    private static function allow_request( $scope, $limit, $window ) {
        $ip = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
        $key = 'luko_rl_' . md5( $scope . '|' . hash_hmac( 'sha256', $ip, wp_salt( 'nonce' ) ) );
        $count = (int) get_transient( $key );
        if ( $count >= $limit ) return false;
        set_transient( $key, $count + 1, $window );
        return true;
    }

    public static function register_rest() {
        register_rest_route( 'luko/v1', '/cart-status', [
            'methods' => 'POST',
            'permission_callback' => [ __CLASS__, 'verify_rest_hmac' ],
            'callback' => [ __CLASS__, 'cart_status' ],
        ] );
    }

    public static function verify_rest_hmac( $request ) {
        if ( ! self::allow_request( 'preflight', 120, 10 * MINUTE_IN_SECONDS ) ) return new WP_Error( 'luko_rate_limited', 'Too many requests.', [ 'status' => 429 ] );
        $secret = self::signing_secret();
        $timestamp = (string) $request->get_header( 'x-luko-timestamp' );
        $provided = (string) $request->get_header( 'x-luko-signature' );
        if ( ! $secret || ! ctype_digit( $timestamp ) || abs( time() - (int) $timestamp ) > 300 || 0 !== strpos( $provided, 'sha256=' ) ) return new WP_Error( 'luko_forbidden', 'Invalid signature.', [ 'status' => 403 ] );
        $expected = 'sha256=' . hash_hmac( 'sha256', $timestamp . '.' . $request->get_body(), $secret );
        if ( ! hash_equals( $expected, $provided ) ) return new WP_Error( 'luko_forbidden', 'Invalid signature.', [ 'status' => 403 ] );
        $replay_key = 'luko_replay_' . hash( 'sha256', $timestamp . '|' . $provided );
        if ( get_transient( $replay_key ) ) return new WP_Error( 'luko_replay', 'Duplicate request.', [ 'status' => 409 ] );
        set_transient( $replay_key, 1, 5 * MINUTE_IN_SECONDS );
        return true;
    }

    public static function cart_status( $request ) {
        $data = $request->get_json_params();
        $external = sanitize_text_field( (string) ( $data['external_cart_id'] ?? '' ) );
        $request_id = sanitize_text_field( (string) ( $data['request_id'] ?? '' ) );
        global $wpdb;
        $row = $wpdb->get_row( $wpdb->prepare( 'SELECT * FROM ' . self::table() . ' WHERE external_cart_id=%s LIMIT 1', $external ) );
        $payload = $row ? json_decode( (string) $row->payload, true ) : [];
        $eligible = $row && 'active' === $row->status && ! $row->order_id && strtotime( $row->expires_at . ' UTC' ) > time() && self::has_consent( (int) $row->user_id ) && ! empty( $payload['items'] );
        return rest_ensure_response( [
            'request_id' => $request_id,
            'external_cart_id' => $external,
            'eligible' => (bool) $eligible,
            'current_consent' => $row ? self::has_consent( (int) $row->user_id ) : false,
            'version' => $row ? (int) $row->version : 0,
            'items' => $row && is_array( $payload['items'] ?? null ) ? $payload['items'] : [],
            'order_id' => $row && $row->order_id ? (int) $row->order_id : null,
        ] );
    }

    public static function admin_menu() {
        add_submenu_page( 'woocommerce', 'LUKO Connector', 'LUKO Connector', 'manage_woocommerce', 'luko-vici', [ __CLASS__, 'admin_page' ] );
    }
    public static function admin_settings() {
        register_setting( 'luko_vici', 'luko_vici_enabled', [ 'sanitize_callback' => 'absint' ] );
        register_setting( 'luko_vici', 'luko_vici_api_base', [ 'sanitize_callback' => 'esc_url_raw' ] );
        register_setting( 'luko_vici', 'luko_vici_signing_secret', [ 'sanitize_callback' => [ __CLASS__, 'sanitize_secret' ] ] );
        register_setting( 'luko_vici', 'luko_vici_phone_meta_key', [ 'sanitize_callback' => 'sanitize_key' ] );
        register_setting( 'luko_vici', 'luko_vici_sms_disclosure', [ 'sanitize_callback' => 'sanitize_textarea_field' ] );
        register_setting( 'luko_vici', 'luko_vici_sms_disclosure_version', [ 'sanitize_callback' => 'sanitize_key' ] );
        register_setting( 'luko_vici', 'luko_vici_terms_url', [ 'sanitize_callback' => 'esc_url_raw' ] );
        register_setting( 'luko_vici', 'luko_vici_recovery_ttl_days', [ 'sanitize_callback' => [ __CLASS__, 'sanitize_ttl' ] ] );
    }
    public static function sanitize_secret( $value ) { $value = trim( (string) $value ); return $value ? $value : (string) get_option( 'luko_vici_signing_secret', '' ); }
    public static function sanitize_ttl( $value ) { return min( 30, max( 1, absint( $value ) ) ); }
    public static function admin_page() {
        if ( ! current_user_can( 'manage_woocommerce' ) ) return;
        ?>
        <div class="wrap"><h1>LUKO Connector</h1><form method="post" action="options.php"><?php settings_fields( 'luko_vici' ); ?>
        <table class="form-table">
        <tr><th>Enabled</th><td><input type="checkbox" name="luko_vici_enabled" value="1" <?php checked( get_option('luko_vici_enabled'), '1' ); ?>></td></tr>
        <tr><th>LUKO API Base URL</th><td><input class="regular-text" name="luko_vici_api_base" value="<?php echo esc_attr(get_option('luko_vici_api_base','')); ?>"></td></tr>
        <tr><th>Signing Secret</th><td><input class="regular-text" type="password" name="luko_vici_signing_secret" value="" autocomplete="new-password" placeholder="Leave blank to keep the current secret"><p>Prefer LUKO_WP_SIGNING_SECRET in wp-config.php.</p></td></tr>
        <tr><th>Phone meta key</th><td><input class="regular-text" name="luko_vici_phone_meta_key" value="<?php echo esc_attr(get_option('luko_vici_phone_meta_key','eael_custom_profile_field_phone_number')); ?>"><p>Confirmed from the live field and Essential Addons 6.8.3 mapping.</p></td></tr>
        <tr><th>Disclosure version</th><td><input name="luko_vici_sms_disclosure_version" value="<?php echo esc_attr(get_option('luko_vici_sms_disclosure_version','v1')); ?>"></td></tr>
        <tr><th>SMS disclosure</th><td><textarea class="large-text" rows="6" name="luko_vici_sms_disclosure"><?php echo esc_textarea(get_option('luko_vici_sms_disclosure','')); ?></textarea></td></tr>
        <tr><th>Terms URL</th><td><input class="regular-text" name="luko_vici_terms_url" value="<?php echo esc_attr(get_option('luko_vici_terms_url','')); ?>"></td></tr>
        <tr><th>Recovery TTL days</th><td><input type="number" min="1" max="30" name="luko_vici_recovery_ttl_days" value="<?php echo esc_attr(get_option('luko_vici_recovery_ttl_days',7)); ?>"></td></tr>
        </table><?php submit_button(); ?></form></div><?php
    }
}

register_activation_hook( __FILE__, [ 'LUKO_Vici_Connector', 'activate' ] );
register_deactivation_hook( __FILE__, [ 'LUKO_Vici_Connector', 'deactivate' ] );
add_action( 'plugins_loaded', function() {
    if ( class_exists( 'WooCommerce' ) ) {
        LUKO_Vici_Connector::boot();
        return;
    }

    add_action( 'admin_notices', function() {
        if ( ! current_user_can( 'activate_plugins' ) ) return;
        echo '<div class="notice notice-error"><p><strong>LUKO Vici Connector:</strong> WooCommerce must be active before this connector can run.</p></div>';
    } );
} );
