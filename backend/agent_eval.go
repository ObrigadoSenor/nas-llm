package main

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// --- Safe arithmetic evaluator (no eval/reflect) ---------------------------
// evalExpr parses and evaluates a constrained arithmetic expression. It is a
// hand-written recursive-descent evaluator so untrusted model output can never
// execute arbitrary code. Grammar (precedence low→high):
//
//	expr   = add
//	add    = mul (("+"|"-") mul)*
//	mul    = pow (("*"|"/") pow)*
//	pow    = unary ("^" pow)?            // right-associative
//	unary  = ("+"|"-") unary | primary
//	primary= number | ident | ident "(" expr ")" | "(" expr ")"
type exprParser struct {
	src string
	i   int
}

func evalExpr(s string) (float64, error) {
	p := &exprParser{src: s}
	p.skipWS()
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	p.skipWS()
	if p.i < len(p.src) {
		return 0, fmt.Errorf("unexpected %q", string(p.src[p.i]))
	}
	return v, nil
}

func (p *exprParser) skipWS() {
	for p.i < len(p.src) && (p.src[p.i] == ' ' || p.src[p.i] == '\t') {
		p.i++
	}
}

func (p *exprParser) parseExpr() (float64, error) { return p.parseAdd() }

func (p *exprParser) parseAdd() (float64, error) {
	l, err := p.parseMul()
	if err != nil {
		return 0, err
	}
	for {
		p.skipWS()
		if p.i >= len(p.src) {
			break
		}
		c := p.src[p.i]
		if c != '+' && c != '-' {
			break
		}
		p.i++
		r, err := p.parseMul()
		if err != nil {
			return 0, err
		}
		if c == '+' {
			l += r
		} else {
			l -= r
		}
	}
	return l, nil
}

func (p *exprParser) parseMul() (float64, error) {
	l, err := p.parsePow()
	if err != nil {
		return 0, err
	}
	for {
		p.skipWS()
		if p.i >= len(p.src) {
			break
		}
		c := p.src[p.i]
		if c != '*' && c != '/' {
			break
		}
		p.i++
		r, err := p.parsePow()
		if err != nil {
			return 0, err
		}
		if c == '*' {
			l *= r
		} else {
			if r == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			l /= r
		}
	}
	return l, nil
}

func (p *exprParser) parsePow() (float64, error) {
	l, err := p.parseUnary()
	if err != nil {
		return 0, err
	}
	p.skipWS()
	if p.i < len(p.src) && p.src[p.i] == '^' {
		p.i++
		r, err := p.parsePow() // right-associative
		if err != nil {
			return 0, err
		}
		return math.Pow(l, r), nil
	}
	return l, nil
}

func (p *exprParser) parseUnary() (float64, error) {
	p.skipWS()
	if p.i < len(p.src) && (p.src[p.i] == '-' || p.src[p.i] == '+') {
		c := p.src[p.i]
		p.i++
		v, err := p.parseUnary()
		if err != nil {
			return 0, err
		}
		if c == '-' {
			return -v, nil
		}
		return v, nil
	}
	return p.parsePrimary()
}

func (p *exprParser) parsePrimary() (float64, error) {
	p.skipWS()
	if p.i >= len(p.src) {
		return 0, fmt.Errorf("unexpected end of expression")
	}
	c := p.src[p.i]
	if c == '(' {
		p.i++
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		p.skipWS()
		if p.i >= len(p.src) || p.src[p.i] != ')' {
			return 0, fmt.Errorf("missing closing parenthesis")
		}
		p.i++
		return v, nil
	}
	if (c >= '0' && c <= '9') || c == '.' {
		start := p.i
		for p.i < len(p.src) && ((p.src[p.i] >= '0' && p.src[p.i] <= '9') || p.src[p.i] == '.') {
			p.i++
		}
		f, err := strconv.ParseFloat(p.src[start:p.i], 64)
		if err != nil {
			return 0, fmt.Errorf("bad number: %s", p.src[start:p.i])
		}
		return f, nil
	}
	if isIdentStart(c) {
		start := p.i
		for p.i < len(p.src) && isIdentPart(p.src[p.i]) {
			p.i++
		}
		name := strings.ToLower(p.src[start:p.i])
		p.skipWS()
		if p.i < len(p.src) && p.src[p.i] == '(' {
			p.i++
			arg, err := p.parseExpr()
			if err != nil {
				return 0, err
			}
			p.skipWS()
			if p.i >= len(p.src) || p.src[p.i] != ')' {
				return 0, fmt.Errorf("missing ) after %s", name)
			}
			p.i++
			return applyFunc(name, arg)
		}
		switch name {
		case "pi":
			return math.Pi, nil
		case "e":
			return math.E, nil
		}
		return 0, fmt.Errorf("unknown identifier: %s", name)
	}
	return 0, fmt.Errorf("unexpected %q", string(c))
}

func applyFunc(name string, arg float64) (float64, error) {
	switch name {
	case "sqrt":
		if arg < 0 {
			return 0, fmt.Errorf("sqrt of negative number")
		}
		return math.Sqrt(arg), nil
	case "abs":
		return math.Abs(arg), nil
	case "sin":
		return math.Sin(arg), nil
	case "cos":
		return math.Cos(arg), nil
	case "tan":
		return math.Tan(arg), nil
	case "log":
		if arg <= 0 {
			return 0, fmt.Errorf("log of non-positive number")
		}
		return math.Log10(arg), nil
	case "ln":
		if arg <= 0 {
			return 0, fmt.Errorf("ln of non-positive number")
		}
		return math.Log(arg), nil
	case "exp":
		return math.Exp(arg), nil
	}
	return 0, fmt.Errorf("unknown function: %s", name)
}

func isIdentStart(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' }

func isIdentPart(c byte) bool {
	return isIdentStart(c) || (c >= '0' && c <= '9')
}
