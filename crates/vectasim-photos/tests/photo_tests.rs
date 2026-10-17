use vectasim_photos::{HIT_TTL_MS, MISS_TTL_MS, Photo, is_fresh, parse_photos};

const FIXTURE: &str = include_str!("fixtures/planespotters_reg.json");

#[test]
fn first_photo_is_taken_from_the_fixture() {
    let p = parse_photos(FIXTURE).unwrap().expect("photo");
    assert_eq!(p.large_url, "https://t.plnspttrs.net/12345/1512345_abcdef_280.jpg");
    assert_eq!(p.thumb_url, "https://t.plnspttrs.net/12345/1512345_abcdef_t.jpg");
    assert_eq!(p.photographer, "Max Mustermann");
    assert_eq!(p.link, "https://www.planespotters.net/photo/1512345/d-aina-lufthansa-airbus-a320-271n");
    assert_eq!(p.credit_line(), "© Max Mustermann · Planespotters.net");
}

#[test]
fn empty_and_partial_responses() {
    assert_eq!(parse_photos(r#"{"photos":[]}"#).unwrap(), None);
    assert_eq!(parse_photos(r#"{}"#).unwrap(), None);
    // a photo without thumbnail_large falls back to the small one
    let p = parse_photos(r#"{"photos":[{"thumbnail":{"src":"s.jpg"},"link":"l","photographer":" A "}]}"#).unwrap().unwrap();
    assert_eq!(p, Photo { large_url: "s.jpg".into(), thumb_url: "s.jpg".into(), photographer: "A".into(), link: "l".into() });
    // a photo without any image is skipped
    let p = parse_photos(r#"{"photos":[{"link":"x"},{"thumbnail_large":{"src":"b.jpg"},"link":"y","photographer":""}]}"#)
        .unwrap()
        .unwrap();
    assert_eq!((p.large_url.as_str(), p.link.as_str()), ("b.jpg", "y"));
    assert_eq!(p.credit_line(), "© Planespotters.net");
    assert!(parse_photos(r#"{"error":"invalid registration"}"#).is_err());
    assert!(parse_photos("<html>").is_err());
}

#[test]
fn cache_ttl_for_hits_misses_and_user_images() {
    let t0 = 1_700_000_000_000;
    assert!(is_fresh(Some("planespotters"), Some(t0), t0 + HIT_TTL_MS - 1));
    assert!(!is_fresh(Some("planespotters"), Some(t0), t0 + HIT_TTL_MS));
    assert!(is_fresh(Some("none"), Some(t0), t0 + MISS_TTL_MS - 1));
    assert!(!is_fresh(Some("none"), Some(t0), t0 + MISS_TTL_MS));
    // a picked image never expires; never looked up means stale
    assert!(is_fresh(Some("user"), None, t0));
    assert!(!is_fresh(None, None, t0));
    assert!(!is_fresh(Some("planespotters"), None, t0));
}

#[tokio::test]
async fn requests_are_spaced_by_the_rate_limit() {
    // an unroutable local port: every request fails fast, but the spacing still applies
    let client = vectasim_photos::PhotoClient::new("http://127.0.0.1:9");
    let start = std::time::Instant::now();
    let _ = client.by_registration("D-AINA").await;
    let _ = client.by_registration("D-AINB").await;
    assert!(start.elapsed() >= vectasim_photos::MIN_INTERVAL, "second request waited {:?}", start.elapsed());
}
