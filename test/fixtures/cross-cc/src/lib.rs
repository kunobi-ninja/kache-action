extern "C" {
    fn answer() -> i32;
}

pub fn call_answer() -> i32 {
    unsafe { answer() }
}
