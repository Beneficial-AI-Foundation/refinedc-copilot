unsigned int fib(unsigned int n) {
    if (n <= 1) return n;

    unsigned int prev = 0;
    unsigned int curr = 1;
    unsigned int i = 1;

    while (i < n) {
        unsigned int next = prev + curr;
        prev = curr;
        curr = next;
        i++;
    }

    return curr;
}
