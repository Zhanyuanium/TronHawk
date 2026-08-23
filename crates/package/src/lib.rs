//! `.thx` (ZIP) package format mechanics: manifest schema validation and safe extraction.
//! A support crate for the Core layer. It must NOT make permission decisions, perform
//! install orchestration, or register plugins — those responsibilities belong to `tronhawk-core`.

#[cfg(test)]
mod tests {
    #[test]
    fn placeholder_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
